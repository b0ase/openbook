"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatedBalance } from "@/components/AnimatedBalance";
import { ChangePassphraseModal } from "@/components/ChangePassphraseModal";
import { EarningsSparkline } from "@/components/EarningsSparkline";
import { FirstEarningToast } from "@/components/FirstEarningToast";
import { InstallPitch } from "@/components/InstallPitch";
import { NymModal } from "@/components/NymModal";
import { ProtectModal } from "@/components/ProtectModal";
import { RestoreModal } from "@/components/RestoreModal";
import { useIdentityContext } from "@/contexts/IdentityContext";
import { useInstallContext } from "@/contexts/InstallContext";
import { satsToDollars, useBsvPrice } from "@/hooks/useBsvPrice";
import { useCurrencyMode } from "@/hooks/useCurrencyMode";
import { readCachedNym, writeCachedNym } from "@/lib/nym-cache";
import { formatShare } from "@/lib/share";
import { titleCaseTicker } from "@/lib/ticker";
import {
  downloadBackup,
  getStoredHint,
  isAddressSaved,
  markAddressSaved,
  shareOrDownloadBackup,
} from "@/services/bsv/backup-template";
import { encryptWif } from "@/services/bsv/crypto";
import { getStoredAnonName, isEffectivelyProtected, unlockIdentity } from "@/services/bsv/identity";
import { getHoldings, getNym, type Holding } from "./actions";
import { FundAddress } from "./FundAddress";

const BACKED_UP_KEY = "openbook_identity_backed_up";
const PASSPHRASE_NUDGE_DISMISSED_UNTIL_KEY = "openbook_passphrase_nudge_dismissed_until";
const PASSPHRASE_NUDGE_BACKOFF_DAYS = 30;

function isPassphraseNudgeSuppressed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(PASSPHRASE_NUDGE_DISMISSED_UNTIL_KEY);
    if (raw === null) return false;
    const until = Number(raw);
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

function suppressPassphraseNudge(): void {
  try {
    const until = Date.now() + PASSPHRASE_NUDGE_BACKOFF_DAYS * 24 * 60 * 60 * 1000;
    window.localStorage.setItem(PASSPHRASE_NUDGE_DISMISSED_UNTIL_KEY, String(until));
  } catch {
    // localStorage write failed — nudge will re-appear next session, acceptable.
  }
}

// ─── Main IdentityChip ─────────────────────────────────────────────────────

export function IdentityChip({
  onOpenThread,
}: {
  /**
   * Open a token's thread. Optional so a surface that has nowhere to put a
   * thread (or is already showing one) can leave the rows inert rather than
   * render a control that does nothing.
   */
  onOpenThread?: (rootId: number) => void;
} = {}): React.JSX.Element | null {
  const {
    identity,
    isLoading,
    needsUnlock,
    updateIdentity,
    openSignIn,
    isReadOnly,
    openInAppPrompt,
    saveRecoveryNonce,
    isSessionClearBlocked,
    blockSessionClear,
    unblockSessionClear,
  } = useIdentityContext();
  const installCtx = useInstallContext();
  const [open, setOpen] = useState(false);

  // Security state
  const [isProtected, setIsProtected] = useState(false);
  const [backedUp, setBackedUp] = useState<boolean | null>(null);
  // Local "save just happened" flag — historical (per LAUNCH_PLAN decision
  // #10 the inline install pitch was event-shaped, only firing once per save).
  // E32 (2026-06-02) dropped that gate — the inline install pitch now self-
  // gates via the 5-condition `shouldShowInstallPitch` (which requires
  // `protected` so unprotected users see the red banner instead). State kept
  // as a no-op setter so existing call sites compile; underscore prefix
  // signals "set but never read." Will remove in a cleanup pass once the
  // event-based hooks below (closeDropdown, setupHeartbeat) are also retired.
  const [_justBackedUp, setJustBackedUp] = useState(false);
  // After download fires we wait for the user to explicitly acknowledge
  // ("Got it") before flipping backedUp. Prevents the silent "advanced
  // believing backup was saved" failure mode when the browser didn't
  // actually save the file (popup blocker, disk full, CSP deny, etc).
  const [justDownloaded, setJustDownloaded] = useState(false);
  const [transferStatus, setTransferStatus] = useState<string | null>(null);

  // Balance / earnings
  const [earnedSats, setEarnedSats] = useState<number | null>(null);
  const [balanceSats, setBalanceSats] = useState<number | null>(null);
  // Unconfirmed (0-conf) funds still landing — shown as a muted "+X pending"
  // line so spendable (confirmed) stays the honest headline number.
  const [pendingSats, setPendingSats] = useState<number | null>(null);
  const [activity, setActivity] = useState<
    Array<{
      amount: number;
      direction: "in" | "out";
      label: string;
      created_at: string;
      txid?: string;
    }>
  >([]);
  const [earningsHistory, setEarningsHistory] = useState<Array<{ t: string; cumulative: number }>>(
    []
  );
  const bsvPrice = useBsvPrice();
  const { toggle: toggleCurrency, isGoat } = useCurrencyMode();

  // Save recovery file state
  const [downloading, setDownloading] = useState(false);

  // Cached passphrase for the manage modal session (cleared on close / tab blur)
  const reAuthPassphraseRef = useRef("");

  // Import state moved to RestoreModal

  // Advanced section (Show/Copy/Paste key)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [keyRevealed, setKeyRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);

  // Hint for the manage modal (stored-hint from encrypted store)
  const [storedHint, setStoredHint] = useState<string | null>(null);

  // Activity / chart expand
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [chartExpanded, setChartExpanded] = useState(true);

  // Threads this identity holds a share of. See `getHoldings` — this is the
  // contribution record, not a minted balance.
  /** The public name this identity goes by, or null while still anonymous.
   *  Seeded from the cache so the chip paints the nym immediately rather than
   *  showing `anon_xxxx` until the `getNym` round-trip lands. */
  const [nym, setNym] = useState<string | null>(() => readCachedNym());
  const [showNymModal, setShowNymModal] = useState(false);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [holdingsExpanded, setHoldingsExpanded] = useState(false);

  // Deposit modal
  const [showDeposit, setShowDeposit] = useState(false);
  // Manage identity modal
  const [showManage, setShowManage] = useState(false);
  // Manage modal gate — passphrase verified once on entry, all eligible actions
  // unlocked while modal is open. Show recovery key + Restore still re-prompt.
  // Session destroyed on modal close OR tab blur.
  const [manageAuthed, setManageAuthed] = useState(false);
  // Locked-state passphrase input (rendered inline as the You modal body
  // when manageAuthed === false). The modal opens locked for protected
  // users; on unlock the body cross-fades to the rows.
  const [manageGatePass, setManageGatePass] = useState("");
  const [manageGateError, setManageGateError] = useState("");
  const [manageGateLoading, setManageGateLoading] = useState(false);
  // Reminder click-to-reveal for the locked-state body
  const [hintRevealed, setHintRevealed] = useState(false);
  // Restore modal
  const [showRestoreModal, setShowRestoreModal] = useState(false);

  // Passphrase flows (encrypt-in-place) — Protect (unprotected) + Change (protected)
  const [showProtectModal, setShowProtectModal] = useState(false);
  const [showChangePassModal, setShowChangePassModal] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const gateInputRef = useRef<HTMLInputElement>(null);
  // Track whether each passphrase flow reached "done" (vs Cancel mid-flow).
  // Read in onClose to decide whether to close the You modal entirely (the
  // manage gate's cached passphrase is stale after a change) or just dismiss.
  const protectCompletedRef = useRef(false);
  const changeCompletedRef = useRef(false);
  // Same pattern for restore: only close the You modal when a restore COMPLETED
  // (its state is stale under the imported identity). On Cancel, return to it.
  const restoreCompletedRef = useRef(false);

  // ── Helpers defined early for use in effects ──────────────────────────────

  const closeDropdown = useCallback(() => {
    setOpen(false);
    setShowAdvanced(false);
    setKeyRevealed(false);
    setCopied(false);
    setActivityExpanded(false);
    setHoldingsExpanded(false);
    setJustBackedUp(false);
  }, []);

  const loadStoredHint = useCallback(() => {
    try {
      const raw = localStorage.getItem("bfn_keypair_enc");
      if (raw) {
        const parsed = JSON.parse(raw) as { hint?: string };
        setStoredHint(parsed.hint ?? null);
      }
    } catch {
      /* non-critical */
    }
  }, []);

  // ── Effects ──────────────────────────────────────────────────────────────

  useEffect(() => {
    try {
      setBackedUp(localStorage.getItem(BACKED_UP_KEY) === "1");
    } catch {
      // localStorage threw (private browsing quota, Safari ITP, etc.) — treat
      // as "not backed up" so the orange save banner appears and the install
      // pitch stays gated.
      setBackedUp(false);
    }
    // isEffectivelyProtected returns true ONLY when encrypted exists AND no
    // plaintext is present — covers the interrupted-upgrade case where both
    // keys exist and getIdentity falls back to plaintext. Using the narrower
    // isIdentityEncrypted() here would incorrectly route users into a
    // passphrase prompt for a passphrase they may never have set.
    setIsProtected(isEffectivelyProtected());
    loadStoredHint();
  }, [loadStoredHint]);

  useEffect(() => {
    if (!identity) return;
    setIsProtected(isEffectivelyProtected());
    loadStoredHint();
  }, [identity?.address, identity?.wif, identity, loadStoredHint]);

  const fetchLiveBalance = useCallback(() => {
    const address = identity?.address;
    if (!address) return;
    if (document.visibilityState !== "visible") return;
    fetch(`/api/balance?address=${encodeURIComponent(address)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && typeof data.balance === "number") {
          setBalanceSats(data.balance);
          if (typeof data.pending === "number") setPendingSats(data.pending);
        }
        // On failure: preserve last-known balance (don't flash to 0)
      })
      .catch(() => {});
  }, [identity?.address]);

  useEffect(() => {
    if (!identity?.address) return;
    fetchLiveBalance();
    const interval = setInterval(fetchLiveBalance, 30_000);
    return () => clearInterval(interval);
  }, [identity?.address, fetchLiveBalance]);

  // When earnings land (DB row, instant) refetch the chain balance immediately so
  // the 0-conf "+pending" shows on the chip within seconds instead of waiting up
  // to 30s for the next poll — this is what lets the first-earning toast wait for
  // the chip to actually update before prompting the user to save. (QA 2026-06-25)
  useEffect(() => {
    if (earnedSats && earnedSats > 0) fetchLiveBalance();
  }, [earnedSats, fetchLiveBalance]);

  useEffect(() => {
    if (!identity?.address) return;
    fetch(`/api/earnings?address=${encodeURIComponent(identity.address)}`)
      .then((res) => res.json())
      .then((data) => {
        setEarnedSats(data.totalEarned ?? 0);
        setActivity(data.recentActivity ?? []);
        setEarningsHistory(data.earningsHistory ?? []);
      })
      .catch(() => setEarnedSats(0));
  }, [identity?.address]);

  // Holdings load when the panel opens, not on a poll. A share only moves when
  // somebody posts, which is far slower than the 30s earnings cadence, and this
  // is a DB aggregate rather than a cached summary — polling it would be the
  // most expensive query in the panel refreshing to show the same numbers.
  useEffect(() => {
    const pubkey = identity?.pubkey;
    if (!pubkey) return;
    let live = true;
    // The server is authoritative — it also corrects a cache left behind by a
    // different identity restored on this device.
    setNym(readCachedNym(pubkey));
    void getNym(pubkey)
      .then((n: string | null) => {
        if (!live) return;
        setNym(n);
        writeCachedNym(pubkey, n);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [identity?.pubkey]);

  useEffect(() => {
    if (!open || !identity?.pubkey) return;
    let live = true;
    void getHoldings(identity.pubkey)
      .then((h) => {
        if (live) setHoldings(h);
      })
      .catch(() => {
        // Non-critical panel section: an empty list renders the "nothing yet"
        // copy, which is the honest state for a failed read too.
        if (live) setHoldings([]);
      });
    return () => {
      live = false;
    };
  }, [open, identity?.pubkey]);

  // Background earnings poll (30s) — drives the chip flash for real earnings.
  // When the dropdown is open we also refresh the activity feed and earnings
  // history so recent boots/payouts appear live instead of waiting for the next
  // close→reopen cycle. When closed, we stay on the summary=1 fast path.
  useEffect(() => {
    if (!identity?.address) return;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      const url = open
        ? `/api/earnings?address=${encodeURIComponent(identity.address)}`
        : `/api/earnings?address=${encodeURIComponent(identity.address)}&summary=1`;
      fetch(url)
        .then((res) => res.json())
        .then((data) => {
          if (typeof data.totalEarned === "number") setEarnedSats(data.totalEarned);
          if (open) {
            if (Array.isArray(data.recentActivity)) setActivity(data.recentActivity);
            if (Array.isArray(data.earningsHistory)) setEarningsHistory(data.earningsHistory);
          }
        })
        .catch(() => {});
    };
    const interval = setInterval(poll, 30_000);
    poll(); // initial fetch
    return () => clearInterval(interval);
  }, [identity?.address, open]);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      // Don't close the dropdown if a passphrase modal is open — those modals
      // render outside dropdownRef so every click inside them would otherwise
      // trigger this handler.
      if (showProtectModal || showChangePassModal) return;
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        closeDropdown();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, showProtectModal, showChangePassModal, closeDropdown]);

  // Destroy manage session on tab blur — same pattern password managers use.
  useEffect(() => {
    if (!manageAuthed) return;
    // Only destroy the manage gate on tab-blur for genuinely protected users
    // (those with a real passphrase to re-authenticate). Unprotected users
    // bypass the gate on open via `openManageModal()` and have no cached
    // secret to destroy — flipping `manageAuthed` to false would re-render
    // the locked-state passphrase prompt for a passphrase they never set.
    if (!isProtected) return;
    function handleVisibility() {
      if (document.visibilityState === "hidden") {
        // Suppress during active rotation/restore flows — iOS fires
        // visibilitychange→hidden on its own system sheets (Save Password,
        // Share, Files picker) on standalone PWA. Without this guard the
        // wizard's parent re-renders during the sheet and the user never
        // sees the done state. The same flows that call blockSessionClear()
        // automatically protect this handler too via the shared ref.
        if (isSessionClearBlocked()) return;
        setManageAuthed(false);
        reAuthPassphraseRef.current = "";
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [manageAuthed, isProtected, isSessionClearBlocked]);

  // Auto-focus the passphrase input when the You modal opens in locked
  // state. Deferred 320ms (past the slideUp animation) so the iOS keyboard
  // appearing on focus doesn't trigger a layout viewport resize via
  // interactive-widget=resizes-content WHILE the modal is still animating
  // — that race produced a visible fade-then-shift glitch on Safari.
  useEffect(() => {
    if (showManage && !manageAuthed) {
      // Re-read the hint each time the gate opens (mirrors SignInModal). After a
      // just-completed protect, encrypt-in-place keeps the same address/wif, so the
      // identity-change effect never re-fires to pick up the freshly-written hint —
      // without this, the "Need a reminder?" hint is missing until a full refresh.
      loadStoredHint();
      const id = setTimeout(() => gateInputRef.current?.focus(), 320);
      return () => clearTimeout(id);
    }
  }, [showManage, manageAuthed, loadStoredHint]);

  // ── Helpers ────────────────────────────────────────────────────────────

  function resetManageState() {
    setShowAdvanced(false);
    setKeyRevealed(false);
    setCopied(false);
  }

  function closeManageModal() {
    setShowManage(false);
    resetManageState();
    // Destroy manage session on close — also clear the locked-state
    // passphrase input fields so reopening starts fresh.
    setManageAuthed(false);
    setManageGatePass("");
    setManageGateError("");
    setManageGateLoading(false);
    setHintRevealed(false);
    setJustBackedUp(false);
    reAuthPassphraseRef.current = "";
  }

  // Click "Manage" — opens the You modal. Protected users see the
  // locked-state passphrase prompt first; unprotected users go straight
  // to the rows (manageAuthed flipped synchronously to avoid a flash).
  function openManageModal(): void {
    setShowManage(true);
    if (!isProtected) setManageAuthed(true);
  }

  async function handleManageGateConfirm(): Promise<void> {
    if (!manageGatePass) return;
    setManageGateLoading(true);
    setManageGateError("");
    try {
      const unlocked = await unlockIdentity(manageGatePass);
      if (!unlocked) {
        setManageGateError("Wrong passphrase");
        setManageGateLoading(false);
        return;
      }
      // Verified — body cross-fades from passphrase prompt to rows.
      reAuthPassphraseRef.current = manageGatePass;
      setManageAuthed(true);
      setManageGatePass("");
      setManageGateError("");
    } catch {
      setManageGateError("Something went wrong — try again");
    } finally {
      setManageGateLoading(false);
    }
  }

  // ── Save recovery file ─────────────────────────────────────────────────

  function handleSaveFile(): void {
    if (isProtected) {
      // Gate already verified passphrase; use the cached value directly
      if (reAuthPassphraseRef.current) {
        void handleSaveEncrypted(reAuthPassphraseRef.current);
      }
      return;
    }
    // Unprotected: no plaintext export ever. Route to "set a passphrase" —
    // ProtectModal encrypts the key in place and emits the ENCRYPTED recovery
    // file itself (DECISIONS.md "passphrase-gated export — no unencrypted
    // recovery file ever leaves the device").
    if (!identity) return;
    openProtectModal();
  }

  async function handleSaveEncrypted(passphrase: string): Promise<void> {
    if (!identity) return;
    setDownloading(true);

    // Hybrid: synchronously read the cached encrypted WIF if available, so
    // we can call shareOrDownloadBackup with no `await` between the user
    // click and navigator.share (iOS transient activation can't survive an
    // await encryptWif which is ~200-600ms of PBKDF2). For users who've
    // completed normal setup the cache is always populated. The degenerate
    // case (cache missing, must encrypt fresh) falls back to the legacy
    // sync downloadBackup path — slightly worse UX (full-page popup) but
    // still saves the file.
    let cachedEnc: string | null = null;
    try {
      const raw = localStorage.getItem("bfn_keypair_enc");
      if (raw) {
        const parsed = JSON.parse(raw) as { encrypted?: string };
        cachedEnc = parsed.encrypted ?? null;
      }
    } catch {
      // localStorage threw — fall through to async path.
    }

    if (cachedEnc) {
      // Hot path: no await before share, so iOS transient activation survives.
      blockSessionClear();
      try {
        const result = await shareOrDownloadBackup({
          name: identity.name,
          address: identity.address,
          wif_encrypted: cachedEnc,
          pathType: "save",
          createdAt: new Date().toISOString(),
          note: "Use your passphrase to restore.",
          hint: getStoredHint(),
        });
        if (result.shared && !result.cancelled) setJustDownloaded(true);
      } finally {
        unblockSessionClear();
        setTimeout(() => setDownloading(false), 1000);
      }
      return;
    }

    // Degenerate path: cache missing, must encrypt fresh. The `await encryptWif`
    // would consume iOS transient activation before any share call could fire,
    // so fall back to the legacy sync downloadBackup — full-page popup on PWA
    // but the file still saves. Rare in practice (only when cache absent).
    try {
      const encryptedWif = await encryptWif(identity.wif, passphrase);
      downloadBackup({
        name: identity.name,
        address: identity.address,
        wif_encrypted: encryptedWif,
        pathType: "save",
        createdAt: new Date().toISOString(),
        note: "Use your passphrase to restore.",
        hint: getStoredHint(),
      });
      setJustDownloaded(true);
    } catch {
      console.error("OpenBook: save encrypted failed");
    } finally {
      setTimeout(() => setDownloading(false), 1000);
    }
  }

  function markBackedUp() {
    // Always propagate to context first (idempotent) so a transient localStorage
    // hiccup at startup that desynced local + context state can't cause the
    // bottom banner to miss the save event. Then short-circuit on local UI
    // state if we've already flipped justBackedUp in this session.
    installCtx.markBackedUp();
    // E27: also mark THIS specific address as saved. The global flag drives
    // first-time install pitch / first-earning toast etc.; the per-address
    // flag is what hides the "Unsaved key" warning dot after a rotation
    // where the user has already saved a previous key but not this one.
    if (identity) markAddressSaved(identity.address);
    if (backedUp) return;
    setBackedUp(true);
    setJustBackedUp(true);
  }

  // ── Advanced: Show/Copy key ────────────────────────────────────────────

  function handleCopy(): void {
    if (!identity) return;
    navigator.clipboard.writeText(identity.wif);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    markBackedUp();
  }

  function handleRevealKey(): void {
    setKeyRevealed((v) => !v);
  }

  // ── Modal launchers ────────────────────────────────────────────────────

  // Both launchers stack their modal over the You modal; Cancel returns to it,
  // only successful completion closes it (via onClose below).
  function openProtectModal(): void {
    setShowProtectModal(true);
  }

  // Surfaces that can't reach ProtectModal directly (e.g. the Feed-site deposit
  // value-gate's "Save my account") open the save-recovery flow by bumping the
  // context's `saveRecoveryNonce`. Guard the initial 0.
  useEffect(() => {
    if (saveRecoveryNonce > 0) setShowProtectModal(true);
  }, [saveRecoveryNonce]);

  function openChangePassModal(): void {
    setShowChangePassModal(true);
  }

  // ── Loading / identity guards ──────────────────────────────────────────

  if (isLoading) return null;

  // When locked (needsUnlock && !identity), show the chip with the cached name
  // from the encrypted store. Click opens the You modal, which gates on the
  // manage-passphrase flow. Transaction actions open SignInModal instead.
  // A claimed nym IS the user's name — it outranks the generated anon handle
  // everywhere the identity is shown. Without this the chip kept saying
  // `anon_xxxx` after a nym was claimed, since the nym was only rendered in the
  // name row inside the You modal.
  //
  // NOTE: feed author lines still show `anon_xxxx` — that surface is a separate,
  // deliberately deferred change (see ROADMAP), not an oversight here.
  const displayName = nym
    ? `$${titleCaseTicker(nym)}`
    : (identity?.name ?? getStoredAnonName() ?? "...");

  // E27: show the amber warning dot when EITHER the user has never saved any
  // recovery file globally (`backedUp === false` — first-launch UX) OR the
  // current address specifically has no per-address saved flag (post-rotation
  // UX, where the user backed up the OLD key but not yet the NEW one). The
  // latter check reads localStorage on every render — cheap and reactive
  // since IdentityBar re-renders when modals close after a successful save.
  const showWarningDot =
    backedUp === false || (identity != null && !isAddressSaved(identity.address));

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <>
      {/* Modals — rendered at root level to avoid dropdown stacking context */}
      {showProtectModal && identity && (
        <ProtectModal
          identity={identity}
          onComplete={() => {
            // encryptInPlace committed — same key/address, now protected.
            setIsProtected(true);
            protectCompletedRef.current = true;
          }}
          onSaved={() => {
            // Fires only after the user explicitly saves the recovery file.
            markBackedUp();
          }}
          onClose={() => {
            // queueMicrotask defer mirrors the old wizard pattern so the
            // You-modal close runs AFTER the modal's unmount + install-pitch
            // unblock cleanup (avoids the You modal lingering behind the
            // install sheet that fires next).
            const completed = protectCompletedRef.current;
            protectCompletedRef.current = false;
            setShowProtectModal(false);
            if (completed) {
              queueMicrotask(() => closeManageModal());
            }
          }}
        />
      )}
      {/* Mounted beside the other identity modals so it sits above the You panel
          rather than inside it — the panel closes on tab blur, and a claim in
          flight must not be torn down with it. */}
      <NymModal
        open={showNymModal}
        onClose={() => setShowNymModal(false)}
        current={nym}
        onClaimed={(symbol) => {
          setNym(symbol);
          if (identity?.pubkey) writeCachedNym(identity.pubkey, symbol);
        }}
      />
      {showChangePassModal && identity && (
        <ChangePassphraseModal
          isOpen={showChangePassModal}
          currentIdentity={identity}
          preVerifiedPassphrase={reAuthPassphraseRef.current || undefined}
          onSuccess={() => {
            // Same key/address; only the passphrase changed. Mark completion so
            // onClose closes the You modal (its cached passphrase is now stale).
            changeCompletedRef.current = true;
          }}
          onSaved={() => {
            markBackedUp();
          }}
          onClose={() => {
            const completed = changeCompletedRef.current;
            changeCompletedRef.current = false;
            setShowChangePassModal(false);
            if (completed) {
              queueMicrotask(() => closeManageModal());
            }
          }}
        />
      )}
      {showDeposit && identity && (
        <FundAddress
          address={identity.address}
          balance={balanceSats ?? undefined}
          onClose={() => setShowDeposit(false)}
          onSecure={openProtectModal}
        />
      )}

      {showRestoreModal && identity && (
        <RestoreModal
          isOpen={showRestoreModal}
          onClose={() => {
            // Dismissals happen here, not in onSuccess. Keeping the modal
            // mounted after onSuccess lets it render its own "done" state
            // (the amber confirmation card + Got it button).
            const completed = restoreCompletedRef.current;
            restoreCompletedRef.current = false;
            setShowRestoreModal(false);
            // Only close the You modal when a restore actually COMPLETED — it's
            // then showing the previous identity's stale state under the imported
            // identity. On Cancel/X/backdrop, return to the You modal (matching
            // the passphrase flow). closeManageModal handles all gate-state
            // teardown including reAuthPassphraseRef.
            if (completed) closeManageModal();
          }}
          onSuccess={(imported) => {
            restoreCompletedRef.current = true;
            updateIdentity(imported);
            // The file the user just restored IS their backup — mark
            // backedUp so the dropdown banner doesn't reappear and prompt
            // for a redundant new save on a device that already has the
            // recovery file by definition.
            markBackedUp();
          }}
          currentIdentity={identity}
          isProtected={isProtected}
          reAuthPassphrase={reAuthPassphraseRef.current}
        />
      )}

      {/* First-earning save prompt — fires once per device when earnedSats > 0
          and recovery file hasn't been saved. "Save now" opens ProtectModal
          directly (the add-a-passphrase flow that emits the encrypted recovery
          file) — no intermediate You-modal hop. Both buttons set 48h backoff.
          Once backedUp flips true, this never re-evaluates true. */}
      <FirstEarningToast
        earnedSats={earnedSats}
        pendingSats={pendingSats}
        backedUp={backedUp}
        onSaveNow={openProtectModal}
      />

      {/* ── Manage Identity modal ── */}
      {showManage && identity && (
        <>
          {/* Backdrop — full-screen click target for dismiss */}
          <button
            type="button"
            className="fixed inset-0 z-[60] w-full bg-black/75 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out] cursor-default"
            aria-label="Close modal"
            onClick={closeManageModal}
          />

          {/* Modal — pinned near top of viewport (iOS-native pattern). This
              is the tallest modal (earnings + chart + activity + balance
              + rows); max-h-[80svh] with overflow-y-auto lets the content
              scroll inside the card. `svh` excludes browser chrome so
              Android Chrome's address bar can't push the card out of view.
              Modal does NOT track the keyboard; locked-state passphrase
              entry sits above where keyboard slides up. */}
          <div className="fixed inset-0 z-[60] flex items-start justify-center px-6 pt-[6svh] pointer-events-none">
            <div
              className="w-full max-w-sm rounded-2xl border border-amber-400/20 shadow-[0_8px_32px_rgba(0,0,0,0.6)] overflow-hidden pointer-events-auto animate-[slideUp_0.3s_ease-out_backwards] max-h-[80svh] overflow-y-auto"
              style={{ backgroundColor: "#0f0f0f" }}
            >
              <div className="h-px bg-gradient-to-r from-transparent via-amber-400/60 to-transparent" />
              <div className="flex items-center justify-between px-4 py-3 border-b border-amber-400/10">
                <p className="text-sm font-semibold text-zinc-100">You</p>
                <button
                  type="button"
                  onClick={closeManageModal}
                  className="relative -m-3 p-3 text-zinc-500 hover:text-zinc-200 transition-colors"
                  aria-label="Close"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>

              {/* Defense-in-depth: locked-state body renders ONLY for genuinely
                  protected users. Even if `manageAuthed` somehow flips false
                  for an unprotected user (e.g., future code path), they fall
                  through to the unlocked rows where they belong. */}
              {!manageAuthed && isProtected ? (
                <div key="lock" className="px-4 py-4 space-y-3 animate-[fadeIn_0.2s_ease-out]">
                  <input
                    ref={gateInputRef}
                    type="password"
                    autoComplete="current-password"
                    placeholder="Passphrase"
                    value={manageGatePass}
                    onChange={(e) => {
                      setManageGatePass(e.target.value);
                      setManageGateError("");
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && manageGatePass) handleManageGateConfirm();
                    }}
                    className="w-full bg-zinc-900 border border-amber-400/15 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-400/40"
                  />
                  {storedHint &&
                    (hintRevealed ? (
                      <div className="border-l-2 border-amber-500/60 pl-2 py-0.5">
                        <span className="text-[11px] text-amber-400/90">Hint: {storedHint}</span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setHintRevealed(true)}
                        className="text-[11px] text-zinc-500 hover:text-amber-400/90 underline underline-offset-2 transition-colors"
                      >
                        Need a reminder?
                      </button>
                    ))}
                  {manageGateError && <p className="text-[11px] text-red-400">{manageGateError}</p>}
                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={closeManageModal}
                      className="flex-1 bg-zinc-900 text-zinc-400 border border-amber-400/15 rounded-lg px-3 py-2 text-xs font-medium hover:bg-zinc-800 transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleManageGateConfirm}
                      disabled={!manageGatePass || manageGateLoading}
                      className="flex-1 bg-amber-400 text-black rounded-lg px-3 py-2 text-xs font-medium hover:bg-amber-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {manageGateLoading ? "Unlocking..." : "Unlock"}
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  key="rows"
                  className="divide-y divide-amber-400/10 animate-[fadeIn_0.2s_ease-out]"
                >
                  {/* Save recovery file */}
                  {justDownloaded ? (
                    <div className="px-4 py-3 bg-emerald-500/5 border-l-2 border-emerald-500/60">
                      <div className="flex items-start gap-3">
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.75"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden="true"
                          className="text-emerald-400 shrink-0 mt-0.5"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                        <div className="flex-1 min-w-0">
                          <span className="text-xs font-medium text-emerald-300 block">
                            Your file should have downloaded
                          </span>
                          <span className="text-[10px] text-emerald-300/80 block mt-0.5 mb-1.5 leading-relaxed">
                            Move it somewhere safe (phone, cloud, USB). It&apos;s the only way back
                            into your account.
                          </span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              markBackedUp();
                              setJustDownloaded(false);
                            }}
                            className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 rounded-lg px-2.5 py-0.5 text-[10px] font-medium hover:bg-emerald-500/30 transition-colors"
                          >
                            Got it
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={handleSaveFile}
                      disabled={downloading}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-amber-400/5 transition-colors text-left disabled:opacity-40"
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        className={backedUp === false ? "text-amber-400" : "text-zinc-400"}
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <span
                          className={`text-xs font-medium block ${backedUp === false ? "text-amber-400" : "text-zinc-200"}`}
                        >
                          {downloading ? "Saving..." : "Save recovery file"}
                        </span>
                        {backedUp === false && (
                          <span className="text-[10px] text-amber-400/70 block mt-0.5">
                            Not saved yet — save now to avoid losing access
                          </span>
                        )}
                      </div>
                      {backedUp === false && (
                        <span className="relative flex h-2 w-2 shrink-0">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-60" />
                          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                        </span>
                      )}
                    </button>
                  )}

                  {/* Passphrase — protected: change; unprotected: add (encrypt-in-place) */}
                  <button
                    type="button"
                    onClick={() => (isProtected ? openChangePassModal() : openProtectModal())}
                    disabled={!identity}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-amber-400/5 transition-colors text-left disabled:opacity-40"
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className={isProtected ? "text-zinc-400" : "text-red-400"}
                    >
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      {isProtected && <path d="m9 12 2 2 4-4" />}
                    </svg>
                    <div className="flex-1 min-w-0">
                      <span
                        className={`text-xs font-medium block ${isProtected ? "text-zinc-200" : "text-red-400"}`}
                      >
                        Passphrase
                      </span>
                      <span
                        className={`text-[10px] block mt-0.5 ${isProtected ? "text-zinc-500" : "text-red-400/70"}`}
                      >
                        {isProtected
                          ? "Change the passphrase that protects your key"
                          : "Not set — add one so you can recover from any device"}
                      </span>
                    </div>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className="text-zinc-600 shrink-0"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>

                  {/* Restore key from file — opens RestoreModal (stacks on You modal) */}
                  <button
                    type="button"
                    onClick={() => setShowRestoreModal(true)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-amber-400/5 transition-colors text-left"
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className="text-zinc-400"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-medium text-zinc-200 block">
                        Upload your saved file
                      </span>
                      <span className="text-[10px] text-zinc-500 block mt-0.5">
                        Imports posts and earnings from a saved key
                      </span>
                    </div>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className="text-zinc-600 shrink-0"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>

                  {/* Show recovery key (advanced) */}
                  {!showAdvanced ? (
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(true)}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-amber-400/5 transition-colors text-left"
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        className="text-zinc-600"
                      >
                        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium text-zinc-400">
                            Show recovery key
                          </span>
                          <span className="text-[9px] font-medium text-amber-400/60 bg-amber-400/5 border border-amber-400/20 rounded px-1 py-px uppercase tracking-wide">
                            Advanced
                          </span>
                        </div>
                        <span className="text-[10px] text-zinc-500 block mt-0.5">
                          Secret key &mdash; handle with care
                        </span>
                      </div>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        className="text-zinc-600 shrink-0"
                      >
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </button>
                  ) : (
                    <div className="px-4 py-3 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-zinc-200">Recovery key</span>
                        <button
                          type="button"
                          onClick={() => {
                            setShowAdvanced(false);
                            setKeyRevealed(false);
                          }}
                          className="text-[10px] text-red-400/80 hover:text-red-300 transition-colors font-medium"
                        >
                          Cancel
                        </button>
                      </div>
                      <p className="text-[11px] text-red-400 leading-relaxed">
                        Anyone with this key owns your account and any funds in it. Never share it.
                      </p>
                      <div className="bg-amber-400/5 rounded-lg px-2.5 py-1.5 font-mono text-[11px] text-amber-300/70 break-all leading-relaxed">
                        {keyRevealed
                          ? identity.wif
                          : `${"\u2022".repeat(12)}${identity.wif.slice(-4)}`}
                      </div>
                      {!keyRevealed ? (
                        <button
                          type="button"
                          onClick={handleRevealKey}
                          className="w-full bg-amber-400/10 text-amber-300 border border-amber-400/30 rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-amber-400/15 transition-colors"
                        >
                          Reveal key
                        </button>
                      ) : (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={handleRevealKey}
                            className="flex-1 bg-amber-400/10 text-amber-300 border border-amber-400/30 rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-amber-400/15 transition-colors"
                          >
                            Hide key
                          </button>
                          <button
                            type="button"
                            onClick={handleCopy}
                            className="flex-1 bg-amber-400/10 text-amber-300 border border-amber-400/30 rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-amber-400/15 transition-colors"
                          >
                            {copied ? "Copied" : "Copy key"}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <div ref={dropdownRef} className="relative">
        {/* Chip — when locked, click opens SignInModal instead of dropdown */}
        <button
          type="button"
          onClick={() => {
            // Read-only (in-app browser) → route to the open-in-browser prompt.
            if (isReadOnly) {
              openInAppPrompt();
              return;
            }
            if (needsUnlock && !identity) {
              openSignIn();
              return;
            }
            setOpen((v) => !v);
          }}
          className="relative flex items-center gap-1.5 sm:gap-2 rounded-full bg-zinc-900 border border-zinc-800 px-2 py-2 sm:px-3 sm:py-1.5 text-xs sm:text-sm hover:border-zinc-700 transition-colors"
        >
          {/* Static protection-status dot. Hidden while the pulsing backup
              warning is visible to avoid two overlapping amber dots competing
              for attention — the backup warning is urgent and time-sensitive;
              protection status can be seen in the modal. */}
          {!(showWarningDot && backedUp === false) && (
            <span
              className={`w-2 h-2 rounded-full ${isProtected ? "bg-amber-400" : "bg-red-500"}`}
            />
          )}
          <span className="text-zinc-300">{displayName}</span>
          {balanceSats !== null && balanceSats > 0 && (
            // Confirmed/spendable balance — the honest headline. Once there's a
            // spendable balance we show ONLY that (no pending alongside). (QA 2026-06-24)
            <AnimatedBalance
              sats={balanceSats}
              bsvPrice={bsvPrice}
              isGoat={isGoat}
              className="text-[10px]"
              flashTrigger={earnedSats ?? 0}
            />
          )}
          {showWarningDot && (
            <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-amber-500" />
            </span>
          )}
        </button>

        {/* Pending (0-conf) as a muted line BENEATH the chip — kept OUT of the
            button so the incoming amount can't widen the chip into the centered
            "Origin" nav button (QA 2026-06-25). Absolute so it never changes the
            header height; pointer-events-none so taps fall through to the chip.
            Only while spendable is 0 — replaced by the confirmed balance once it
            confirms. Never summed into the spendable headline. */}
        {(balanceSats === null || balanceSats === 0) && pendingSats !== null && pendingSats > 0 && (
          <span className="pointer-events-none absolute top-full right-0 mt-0.5 text-[9px] text-amber-400/50 tabular-nums whitespace-nowrap">
            +
            {isGoat ? `${pendingSats.toLocaleString()} sats` : satsToDollars(pendingSats, bsvPrice)}{" "}
            pending
          </span>
        )}

        {open && identity && (
          <div
            className="absolute right-0 top-full mt-2 w-[calc(100vw-2rem)] sm:w-80 max-w-80 border border-amber-400/20 rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.6)] z-50 overflow-hidden max-h-[85vh] overflow-y-auto"
            style={{ backgroundColor: "#0f0f0f" }}
          >
            {/* Gold top stripe */}
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-400/60 to-transparent" />
            {/* ── Header: name + address + close ── */}
            <div className="px-3 py-2.5 border-b border-amber-400/10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${isProtected ? "bg-amber-400" : "bg-red-500"}`}
                  />
                  <span className="text-sm font-semibold text-white">{displayName}</span>
                  {isProtected && (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-amber-400 shrink-0"
                      aria-label="Identity protected"
                    >
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      closeDropdown();
                      openManageModal();
                    }}
                    className="relative -m-3 p-3 text-zinc-500 hover:text-zinc-200 transition-colors"
                    aria-label="Manage"
                    title="Manage"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    onClick={closeDropdown}
                    className="relative -m-3 p-3 text-zinc-500 hover:text-zinc-200 transition-colors"
                    aria-label="Close"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  navigator.clipboard.writeText(identity.address);
                  setAddressCopied(true);
                  setTimeout(() => setAddressCopied(false), 1500);
                }}
                className="flex items-center gap-1.5 ml-4 mt-1 py-2 -my-2 group cursor-copy"
              >
                <span
                  className={`text-xs font-mono ${addressCopied ? "text-emerald-400" : "text-zinc-400"} group-hover:text-zinc-200 transition-colors`}
                >
                  {addressCopied
                    ? "Copied!"
                    : `${identity.address.slice(0, 6)}...${identity.address.slice(-4)}`}
                </span>
                {!addressCopied && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="text-zinc-500 group-hover:text-zinc-200 transition-colors"
                  >
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>
            </div>

            {/* ── One-time backup banner — persists until the user saves
                 AND acknowledges, then gone forever. Coinbase/Phantom
                 pattern: no recurring guilt, single clear CTA above
                 everything else.
                 After download fires, the banner flips to a "Got it"
                 confirmation — only on explicit click does backedUp get
                 marked, so if the browser silently failed to save, the
                 banner re-appears. ── */}
            {backedUp === false && !justDownloaded && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  // Any path that produces an externalized recovery file
                  // (ProtectModal save, ChangePassphraseModal save, RestoreModal
                  // success) sets backedUp=true. So this banner is only
                  // reachable for unprotected users — direct download, no
                  // re-auth needed.
                  handleSaveFile();
                }}
                disabled={downloading}
                className="w-full flex items-center gap-3 px-3 py-2.5 bg-amber-500/10 border-b border-amber-500/30 hover:bg-amber-500/15 transition-colors text-left disabled:opacity-50"
              >
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-60" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
                </span>
                <div className="flex-1 min-w-0">
                  <span className="text-[11px] font-medium text-amber-400 block">
                    {downloading ? "Saving..." : "Save your recovery file"}
                  </span>
                  <span className="text-[10px] text-amber-400/70 block">
                    {isProtected
                      ? "One tap — lets you get back in from any device."
                      : "One tap to set a passphrase and save your recovery file."}
                  </span>
                </div>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  className="text-amber-400 shrink-0"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            )}
            {backedUp === false &&
              justDownloaded &&
              (!isProtected && !isPassphraseNudgeSuppressed() ? (
                // C2: passphrase upgrade nudge — replaces the generic "Got it"
                // confirmation for unprotected users. Each plaintext save is a
                // new exposure surface, so this fires on every save unless
                // suppressed via "Not now" (30-day backoff). Both buttons
                // acknowledge the save (markBackedUp + clear justDownloaded);
                // Add passphrase additionally opens the protect (encrypt-in-place) flow.
                <div className="px-3 py-2.5 bg-amber-500/10 border-b border-amber-500/30 flex items-start gap-3">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="text-amber-400 shrink-0 mt-0.5"
                  >
                    <rect x="3" y="11" width="18" height="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <span className="text-[11px] font-semibold text-amber-300 block">
                      Add a passphrase?
                    </span>
                    <span className="text-[10px] text-amber-400/80 block mt-0.5 mb-2 leading-relaxed">
                      Your file is plain text right now &mdash; whoever opens it is you. Locking it
                      with a passphrase means only you can use it.
                    </span>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          markBackedUp();
                          setJustDownloaded(false);
                          openProtectModal();
                        }}
                        className="bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-lg px-3 py-2 text-[11px] font-medium hover:bg-amber-500/30 transition-colors"
                      >
                        Add passphrase
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          markBackedUp();
                          setJustDownloaded(false);
                          suppressPassphraseNudge();
                        }}
                        className="bg-zinc-900 text-zinc-400 border border-amber-400/15 rounded-lg px-3 py-2 text-[11px] font-medium hover:bg-zinc-800 transition-colors"
                      >
                        Not now
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                // Protected users (already encrypted) and suppressed users
                // get the generic confirmation. Still acknowledges the file
                // download before flipping backedUp = true (silent-failure
                // protection per the existing pattern).
                <div className="px-3 py-2.5 bg-emerald-500/10 border-b border-emerald-500/30 flex items-start gap-3">
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="text-emerald-400 shrink-0 mt-0.5"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <span className="text-[11px] font-medium text-emerald-300 block">
                      Your file should have downloaded
                    </span>
                    <span className="text-[10px] text-emerald-300/80 block mt-0.5 mb-2 leading-relaxed">
                      Move it somewhere safe (phone, cloud, USB). It&apos;s the only way back into
                      your account.
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        markBackedUp();
                        setJustDownloaded(false);
                      }}
                      className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 rounded-lg px-3 py-2 text-[11px] font-medium hover:bg-emerald-500/30 transition-colors"
                    >
                      Got it
                    </button>
                  </div>
                </div>
              ))}

            {/* ── Inline install pitch — permanent escape hatch for users who
                 dismissed the slide-up sheet popup. Self-gates via the 5-condition
                 `shouldShowInstallPitch` (which now requires `protected`, so
                 unprotected users see the red "Not protected" banner below
                 INSTEAD of this row). Drops the prior `justBackedUp` event-
                 only gate so the row stays visible across modal opens until
                 the user installs. See DECISIONS.md "Install pitch dual-
                 surface" + 2026-06-02 protected-gate decision. ── */}
            <InstallPitch variant="inline" />

            {/* ── Security warning (unprotected only — protected uses inline checkmark) ── */}
            {!isProtected && (
              <div className="border-b border-zinc-800">
                <button
                  type="button"
                  onClick={() => {
                    closeDropdown();
                    openProtectModal();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 bg-red-950/20 hover:bg-red-950/40 transition-colors cursor-pointer text-left"
                >
                  <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                  <span className="text-[11px] text-red-400 font-medium flex-1">Not protected</span>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    className="text-red-400/60 shrink-0"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
            )}

            {/* ── All-time earnings (hero section, collapsible chart, default open) ── */}
            <div className="px-3 py-2.5 border-b border-amber-400/10 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium block mb-0.5">
                    All-time earnings
                  </span>
                  <span className="text-xl text-amber-400 font-bold tabular-nums">
                    {earnedSats !== null && earnedSats > 0
                      ? isGoat
                        ? `${earnedSats.toLocaleString()} sats`
                        : satsToDollars(earnedSats, bsvPrice)
                      : isGoat
                        ? "0 sats"
                        : "$0.00"}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleCurrency();
                  }}
                  className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-full border border-amber-400/25 text-zinc-300 hover:text-white hover:border-amber-400/50 hover:bg-amber-400/5 transition-colors"
                  title={isGoat ? "Switch to dollar mode" : "Switch to sats mode"}
                >
                  {isGoat ? <span>🐐 Goat</span> : <span>💵 Noob</span>}
                </button>
              </div>
              <button
                type="button"
                onClick={() => setChartExpanded((v) => !v)}
                className="w-full flex items-center justify-end gap-1 group py-2 -my-1"
              >
                <span className="text-[10px] text-zinc-500 group-hover:text-zinc-300 transition-colors">
                  {chartExpanded ? "Hide chart" : "Show chart"}
                </span>
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  className={`text-zinc-500 group-hover:text-zinc-300 transition-transform ${chartExpanded ? "rotate-180" : ""}`}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {chartExpanded && (
                <EarningsSparkline
                  history={earningsHistory}
                  totalSats={earnedSats ?? 0}
                  isGoat={isGoat}
                  bsvPrice={bsvPrice}
                />
              )}
            </div>

            {/* ── Activity (2 visible, expand to see all) ── */}
            <div className="px-3 py-2.5 border-b border-amber-400/10 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">
                  Activity
                </span>
                {activity.length > 2 && (
                  <button
                    type="button"
                    onClick={() => setActivityExpanded((v) => !v)}
                    className="relative -my-2 py-2 text-[11px] text-zinc-100 font-medium underline underline-offset-2 decoration-zinc-600 hover:decoration-zinc-400 transition-colors"
                  >
                    {activityExpanded ? "Show less" : `View all ${activity.length}`}
                  </button>
                )}
              </div>
              {activity.length === 0 ? (
                <p className="text-[11px] text-zinc-600 leading-relaxed">
                  Your earnings show here &mdash; share an idea, or boost posts you like.
                </p>
              ) : (
                <div className="space-y-1">
                  {(activityExpanded ? activity : activity.slice(0, 2)).map((a, i) => {
                    const isFree = a.amount === 0;
                    const isBoot = a.label.toLowerCase().includes("boot");
                    // List is read-only, server-sorted, fully replaced on each fetch — index disambiguates same-timestamp payouts
                    return (
                      <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: see comment above
                        key={`${a.created_at}-${a.label}-${i}`}
                        className="flex items-center justify-between text-[11px]"
                      >
                        <span className="text-zinc-500 truncate mr-2">
                          {a.label}
                          {isBoot && (
                            <span
                              className={`ml-1 text-[10px] ${isFree ? "text-zinc-600" : "text-amber-500/70"}`}
                            >
                              {isFree
                                ? "· free"
                                : isGoat
                                  ? `· ${a.amount.toLocaleString()} sats`
                                  : `· ${satsToDollars(a.amount, bsvPrice)}`}
                            </span>
                          )}
                        </span>
                        <span
                          className={`font-mono shrink-0 ${a.direction === "in" ? "text-amber-400" : "text-zinc-500"}`}
                        >
                          {isFree ? (
                            <span className="text-zinc-600 text-[10px] font-sans">FREE</span>
                          ) : (
                            <>
                              {a.direction === "in" ? "+" : "-"}
                              {isGoat
                                ? a.amount.toLocaleString()
                                : satsToDollars(a.amount, bsvPrice)}
                            </>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Your name ──
                Placed ABOVE Tokens deliberately: it is the thing a new arrival
                looks for first, and the owner asked for it to be obvious rather
                than buried in settings. Claiming POSTS it — see NymModal. */}
            <div className="px-3 py-2.5 border-b border-amber-400/10">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">
                  Your name
                </span>
                <button
                  type="button"
                  onClick={() => setShowNymModal(true)}
                  className="relative -my-2 py-2 text-[11px] text-zinc-100 font-medium underline underline-offset-2 decoration-zinc-600 hover:decoration-amber-400/60 transition-colors"
                >
                  {nym ? "Change" : "Choose one"}
                </button>
              </div>
              <p className="mt-1 text-[13px]">
                {nym ? (
                  <span className="text-amber-400 font-medium">${titleCaseTicker(nym)}</span>
                ) : (
                  <span className="text-zinc-500">
                    {identity?.name ?? "anon"}{" "}
                    <span className="text-zinc-600">
                      &mdash; pick a name people can find you by
                    </span>
                  </span>
                )}
              </p>
            </div>

            {/* ── Tokens ──
                ⚠ THESE ARE TOKENS, NOT A PREVIEW OF TOKENS. Posting IS the mint
                (TOKENS.md, one token per contribution): a user creates and owns
                a token the moment they post, and this is where they see what
                they own. An earlier version of this panel hedged — "your
                threads", "not minted yet" — which contradicted the model the
                product is built on. What does NOT exist yet is the MARKET (paid
                posting, depleting supply, any way to trade), and that is the
                only thing the copy here should qualify. */}
            <div className="px-3 py-2.5 border-b border-amber-400/10 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">
                  Tokens
                </span>
                {holdings.length > 3 && (
                  <button
                    type="button"
                    onClick={() => setHoldingsExpanded((v) => !v)}
                    className="relative -my-2 py-2 text-[11px] text-zinc-100 font-medium underline underline-offset-2 decoration-zinc-600 hover:decoration-zinc-400 transition-colors"
                  >
                    {holdingsExpanded ? "Show less" : `View all ${holdings.length}`}
                  </button>
                )}
              </div>
              {holdings.length === 0 ? (
                <p className="text-[11px] text-zinc-600 leading-relaxed">
                  Post an idea and your share of the thread shows up here.
                </p>
              ) : (
                <>
                  <div className="space-y-1">
                    {(holdingsExpanded ? holdings : holdings.slice(0, 3)).map((h) => (
                      // A holding is a token, and a token IS a post — so the row
                      // opens the thread it names. `root_id` serves both kinds:
                      // a named token's thread, or the post token itself. Falls
                      // back to a plain row when the host gave us nowhere to
                      // open one, rather than rendering a dead control.
                      <button
                        type="button"
                        key={h.root_id}
                        disabled={!onOpenThread}
                        onClick={() => {
                          if (!onOpenThread) return;
                          closeDropdown();
                          onOpenThread(h.root_id);
                        }}
                        className="flex w-full items-center justify-between gap-2 text-left text-[11px] enabled:hover:text-zinc-200 transition-colors"
                      >
                        <span className="truncate text-zinc-400">
                          {h.kind === "name" ? (
                            h.path.map((seg, i) => (
                              <span key={seg}>
                                {i > 0 && <span className="text-zinc-700">/</span>}
                                <span
                                  className={
                                    i === h.path.length - 1 ? "text-amber-400" : "text-zinc-600"
                                  }
                                >
                                  ${titleCaseTicker(seg)}
                                </span>
                              </span>
                            ))
                          ) : (
                            // An UNNAMED token, shown by what it SAYS. The txid
                            // is still its true identifier and stays on hover —
                            // but a wallet full of hashes told the holder
                            // nothing about which of their posts each one was.
                            <span className="text-zinc-500" title={h.tx_id ?? undefined}>
                              {h.excerpt || `unanchored #${h.root_id}`}
                            </span>
                          )}
                        </span>
                        {/* ⚠ A SHARE IS PRINTED ONLY FOR NAMES. An unnamed post
                            is a 1-of-1, so "100%" there never meant a holding —
                            it meant "I wrote this", sitting in the same column
                            as a real share of a contested name. That collision
                            is what made this panel read as inconsistent. */}
                        {h.kind === "name" ? (
                          <span className="flex shrink-0 items-center gap-2 font-mono tabular-nums">
                            <span className="text-zinc-600">
                              {h.mine}/{h.total}
                            </span>
                            <span className="text-amber-400">{formatShare(h.mine, h.total)}</span>
                          </span>
                        ) : (
                          <span className="shrink-0 font-mono tabular-nums text-zinc-600">
                            1-of-1
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] leading-relaxed text-zinc-600">
                    One post, one token. Yours to keep &mdash; there&rsquo;s nowhere to trade them
                    yet.
                  </p>
                </>
              )}
            </div>

            {/* ── Balance (demoted — secondary to earnings) ── */}
            <div className="px-3 py-2 border-b border-amber-400/10">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">
                  Balance
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-white font-semibold tabular-nums">
                    {isGoat
                      ? `${(balanceSats ?? 0).toLocaleString()} sats`
                      : satsToDollars(balanceSats ?? 0, bsvPrice)}
                  </span>
                  <span className="text-zinc-600">·</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isReadOnly) {
                        openInAppPrompt();
                        return;
                      }
                      closeDropdown();
                      setShowDeposit(true);
                    }}
                    className="relative -my-2 py-2 text-[11px] text-amber-400 hover:text-amber-300 underline-offset-2 hover:underline transition-colors"
                  >
                    Add funds
                  </button>
                </div>
              </div>
              {pendingSats !== null && pendingSats > 0 && (
                <div
                  className="mt-0.5 text-right text-[11px] text-zinc-500 tabular-nums"
                  title="Confirming on-chain — spendable in a few minutes"
                >
                  +
                  {isGoat
                    ? `${pendingSats.toLocaleString()} sats`
                    : satsToDollars(pendingSats, bsvPrice)}{" "}
                  pending
                </div>
              )}
            </div>

            {/* ── Transient banners ── */}
            {transferStatus && (
              <div
                className={`px-3 py-2 border-b text-[11px] leading-relaxed ${
                  transferStatus.startsWith("Note:")
                    ? "border-amber-900/40 bg-amber-950/20 text-amber-400"
                    : "border-emerald-900/30 bg-emerald-950/20 text-emerald-400"
                }`}
              >
                {transferStatus}
                <button
                  type="button"
                  onClick={() => setTransferStatus(null)}
                  className="ml-2 text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Dismiss
                </button>
              </div>
            )}

            {/* Legal links (Phase 3 surfacing) */}
            <div className="flex items-center justify-center gap-2 px-3 py-2.5 text-[10px] text-zinc-600">
              <a href="/terms" className="transition-colors hover:text-zinc-400">
                Terms
              </a>
              <span>·</span>
              <a href="/privacy" className="transition-colors hover:text-zinc-400">
                Privacy
              </a>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
