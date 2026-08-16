/**
 * How long a post may be, and when it gets folded in the feed.
 *
 * ⚠ THERE IS NO LENGTH LIMIT AS A PRODUCT RULE ANY MORE (owner, 2026-08-16).
 * Posting is paid and priced by size — a longer post inscribes more bytes and
 * costs its author more sats — so length polices itself with the author's own
 * money. A 1,000-character cap on top of that was the platform second-guessing a
 * decision the author already paid for.
 *
 * ⚠ THE CEILING BELOW IS NOT A LENGTH LIMIT, IT IS AN ABUSE CEILING, and it has
 * to stay. The cost of a long post is NOT borne only by its author: every post
 * sits in SQLite and is re-sent to every client on every 5s feed poll, so one
 * 50MB post is a bill everybody pays forever, and the author paid once. The
 * ceiling is set far above anything a person would type — roughly a 15,000-word
 * essay — so it never acts as an editorial limit, only as a backstop against a
 * script.
 */
export const MAX_POST_CHARS = 100_000;

/**
 * Above this, the feed folds a post behind "Show more".
 *
 * A feed is a list you scan. One very long post between two short ones does not
 * just take space, it hides everything after it — so the fold protects OTHER
 * people's posts, not the reader's patience. Generous enough that an ordinary
 * long post still shows in full.
 */
export const FOLD_POST_CHARS = 1_200;

/** Whether the feed should fold this post. */
export function shouldFold(content: string): boolean {
  return content.length > FOLD_POST_CHARS;
}
