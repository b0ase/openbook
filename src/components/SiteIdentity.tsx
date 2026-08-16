"use client";

import { IdentityChip } from "@/app/IdentityBar";
import { BootProvider } from "@/contexts/BootContext";
import { IdentityProvider } from "@/contexts/IdentityContext";
import { InstallProvider } from "@/contexts/InstallContext";
import { InAppPromptModal } from "./InAppPromptModal";
import { SignInModal } from "./SignInModal";

/**
 * The wallet chip, for pages that are not the feed.
 *
 * ⚠ THE CHIP BELONGS ON EVERY PAGE THE USER CAN REACH, because it is about THEM
 * and not about the page. It only ever rendered inside the feed, so following a
 * link to `/tickers` or a leaderboard dropped the user's balance, their name and
 * their way into their own wallet — on exactly the pages that talk about what
 * they hold. A wallet you can only see on the front page is a wallet you have to
 * navigate away from your holdings to check.
 *
 * ⚠ MOUNTS ITS OWN PROVIDERS, DELIBERATELY. The stack lives inside `Feed`, and
 * hoisting it into the root layout would change how identity mounts for the feed
 * itself — the most delicate surface in the app, with an unlock session, a
 * pagehide teardown and a cross-tab sync all keyed to it. A page renders either
 * the feed or this, never both, so each page still has exactly one provider tree
 * and nothing about the feed's mounting changes.
 *
 * The sign-in and in-app modals come along because the chip can open both: a
 * locked user tapping it needs somewhere to unlock, and a read-only in-app
 * browser needs the explainer. A chip that opens a modal that was never mounted
 * is a dead control.
 *
 * `onOpenThread` is intentionally omitted — these pages have no thread overlay
 * to open, and `IdentityChip` already renders those rows inert rather than
 * offering a control that goes nowhere.
 */
export function SiteIdentity() {
  return (
    <BootProvider>
      <IdentityProvider>
        <InstallProvider>
          <SignInModal />
          <InAppPromptModal />
          <IdentityChip />
        </InstallProvider>
      </IdentityProvider>
    </BootProvider>
  );
}
