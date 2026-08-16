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
 * Identity hues, in degrees, spread as widely as the reserved bands allow.
 *
 * ⚠ 18° IS NOT ENOUGH — THIS WAS MEASURED, NOT GUESSED. The first version of
 * this palette packed ten hues in at >= 18° apart. In production two of the four
 * live authors landed on 285 and 305 and were reported as "both purple", and a
 * third collided outright. Twenty degrees inside the same colour family reads as
 * one colour at 12px, whatever the wheel says. **Do not narrow these gaps to fit
 * more entries in** — a palette that fits everyone but distinguishes nobody is
 * the failure this exists to prevent. Widen the SECOND axis below instead.
 *
 * Minimum gap is now 28°, and consecutive entries deliberately cross colour
 * families (lime → green → teal → blue → indigo → purple → magenta → rose)
 * rather than stepping through shades of one.
 */
const HUES = [96, 132, 176, 212, 248, 284, 316, 344] as const;

/**
 * The second axis: how light the colour is.
 *
 * Eight hues alone gave an exact collision at FOUR users — with a small board
 * that is not a tail case, it is the common case. Lightness roughly doubles the
 * distinguishable space without pushing any hue closer to its neighbour, and a
 * 16-point difference in lightness is obvious even within one hue. Both tiers
 * stay bright enough to read on the near-black page.
 *
 * This is mitigation, not elimination: 16 buckets still collide eventually. The
 * goal is that two authors *adjacent in the feed* are usually tellable apart,
 * which is what the colour was asked for.
 */
const LIGHTNESS = [72, 56] as const;

/** Which (hue, lightness) bucket an identity falls in. */
function bucket(seed: string): number {
  return hash(seed) % (HUES.length * LIGHTNESS.length);
}

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
  return HUES[bucket(seed) % HUES.length];
}

/**
 * The identity's lightness. Exported alongside the hue so a caller building its
 * own treatment gets the WHOLE colour, not just half of it — using the hue on
 * its own would merge the two tiers back together.
 */
export function identityLightness(seed: string | null | undefined): number {
  if (!seed) return LIGHTNESS[0];
  return LIGHTNESS[Math.floor(bucket(seed) / HUES.length)];
}

/**
 * The handle colour — saturated, high contrast against the near-black page.
 */
export function identityColor(seed: string | null | undefined): string {
  return `hsl(${identityHue(seed)} 85% ${identityLightness(seed)}%)`;
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
  // Carries the lightness tier too, at a much gentler spread (86 / 79), so a
  // paragraph still groups with its handle without either tier going dim.
  const tier = identityLightness(seed) === LIGHTNESS[0] ? 86 : 79;
  return `hsl(${identityHue(seed)} 42% ${tier}%)`;
}
