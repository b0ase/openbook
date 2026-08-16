/**
 * A stable colour per identity, derived from the identity itself.
 *
 * WHY DERIVED, NOT STORED: a colour column would need a migration, a picker, a
 * uniqueness rule and a backfill for 2,000+ existing posts. Hashing the pubkey
 * gives every author — past, present, and anyone who arrives tomorrow — a
 * distinct stable colour for free, and it is identical on the server and the
 * client so it cannot flicker on hydration.
 *
 * ⚠ SEED ON THE PUBKEY, NOT THE DISPLAY NAME. A `$Nym` can be claimed after the
 * fact, which would recolour every one of that author's old posts the moment
 * they picked a name. The pubkey is the thing that never changes — the same
 * property that makes it the attribution key everywhere else in the app.
 *
 * ⚠ THREE HUE BANDS ARE RESERVED AND MUST STAY EXCLUDED. In this UI:
 *   - amber  (~38°)  means "this is a claimed $Name / a $Ticker"
 *   - emerald(~152°) means "signed" and "on chain"
 *   - red    (~0°)   means "warning / unprotected / failure"
 * An identity that happened to land on one of those would read as a STATUS
 * rather than as a person. Every hue below is chosen to sit clear of them, so
 * colour-as-identity and colour-as-meaning never collide.
 */

/**
 * Identity hues, in degrees. Pink → violet → blue → cyan, plus one lime.
 *
 * Deliberately not evenly spaced around the wheel: the gaps are where the
 * reserved bands live. Adjacent entries are >= 18° apart so neighbours stay
 * tellable apart at 12px, which is the size a handle actually renders at.
 */
const HUES = [346, 328, 305, 285, 265, 244, 220, 199, 180, 96] as const;

/** FNV-1a. Dependency-free, stable across runtimes, good enough to spread ~10 buckets. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    // FNV prime, via shifts so this stays in 32-bit int math.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * The identity's hue. Exported so a caller can build its own treatment (a
 * border, a glow) in the SAME colour as the handle without re-deriving it.
 */
export function identityHue(seed: string | null | undefined): number {
  if (!seed) return HUES[0];
  return HUES[hash(seed) % HUES.length];
}

/**
 * The handle colour — saturated, high contrast against the near-black page.
 */
export function identityColor(seed: string | null | undefined): string {
  return `hsl(${identityHue(seed)} 85% 70%)`;
}

/**
 * The body-text colour for the same identity.
 *
 * Much closer to the page's normal near-white than the handle is. Post bodies
 * are paragraphs, and a paragraph set in a saturated colour is a paragraph
 * people stop reading — the tint only has to be enough to group a run of posts
 * by author at a glance, which is what it was asked for.
 */
export function identityTextColor(seed: string | null | undefined): string {
  return `hsl(${identityHue(seed)} 42% 86%)`;
}
