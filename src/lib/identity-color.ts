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
 * How light every identity colour is. ONE value, deliberately.
 *
 * ⚠ DO NOT VARY LIGHTNESS PER IDENTITY — IT WAS TRIED AND IT BROKE CONTRAST.
 * The second axis was briefly a lightness tier of 72%/56%. HSL lightness is not
 * perceptually uniform: at 56% a green is bright and an indigo is nearly unread-
 * able. `$B0ase` shipped as `hsl(248 85% 56%)` = rgb(73,47,238), which is
 * **2.75:1** against the page — under the 4.5:1 floor for text this size. Holding
 * lightness constant is what keeps every hue legible, so the second axis has to
 * be something else.
 */
const LIGHTNESS = 72;

/**
 * The second axis: saturation. Vivid or muted, at the SAME lightness.
 *
 * Eight hues alone gave an exact collision at FOUR users — on a small board that
 * is the common case, not the tail. Saturation roughly doubles the buckets
 * without moving any hue nearer its neighbour and without changing how bright
 * anything is, so it cannot reintroduce the contrast problem above.
 *
 * This is mitigation, not elimination: 16 buckets still collide eventually. The
 * goal is that two authors *adjacent in the feed* are usually tellable apart,
 * which is what the colour was asked for.
 */
const SATURATION = [88, 45] as const;

/** Which (hue, lightness) bucket an identity falls in. */
function bucket(seed: string): number {
  return hash(seed) % (HUES.length * SATURATION.length);
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
 * The identity's saturation. Exported alongside the hue so a caller building its
 * own treatment gets the WHOLE colour, not just half of it — using the hue on
 * its own would merge the two tiers back together.
 */
export function identitySaturation(seed: string | null | undefined): number {
  if (!seed) return SATURATION[0];
  return SATURATION[Math.floor(bucket(seed) / HUES.length)];
}

/**
 * The handle colour — high contrast against the near-black page at every hue.
 */
export function identityColor(seed: string | null | undefined): string {
  return `hsl(${identityHue(seed)} ${identitySaturation(seed)}% ${LIGHTNESS}%)`;
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
  // Carries the saturation tier too, at a much gentler spread (42 / 24), so a
  // paragraph still groups with its handle without either tier shouting. The
  // lightness is higher than the handle's and, again, the same for every hue.
  const tier = identitySaturation(seed) === SATURATION[0] ? 42 : 24;
  return `hsl(${identityHue(seed)} ${tier}% 86%)`;
}
