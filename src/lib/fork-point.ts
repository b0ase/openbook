/**
 * Where OpenBooks stops being OpenCook.
 *
 * Post 2023 is *"i forked OpenCook and added tokens"* — the post that announced
 * this fork, written on upstream. Posts 1..2023 are SHARED HISTORY: they happened
 * on OpenCook, they are signed by their original authors and anchored on-chain
 * under `app: "opencook"`, and they are reproduced here faithfully rather than
 * re-created. Everything after 2023 is OpenBooks's own timeline.
 *
 * ⚠ THE `app` LITERAL DOES NOT MARK THE FORK, AND NEVER DID. This fork kept
 * writing `app: "opencook"` too, so records 1..~2081 share that tag across both
 * sides of the boundary; `ONCHAIN_APP` only became "openbook" on 2026-08-16.
 * `FORK_POINT_ID` is what separates upstream's history from ours — do not reach
 * for the `app` tag to do that job, it cannot.
 *
 * ⚠ THIS IS A HISTORICAL FACT, NOT A SETTING. It records something that already
 * happened, so it never changes. Do not "update" it when new posts arrive — the
 * fork point does not move, and moving it would silently reclassify other
 * people's posts as ours.
 *
 * Why a constant rather than a query: the boundary cannot be derived from the
 * data. An inherited post and an original post are both just rows with ids and
 * timestamps; only this number knows which side of the fork each came from.
 */
export const FORK_POINT_ID = 2023;

/** True for posts inherited from OpenCook rather than written on OpenBooks. */
export function isInheritedPost(postId: number): boolean {
  return postId <= FORK_POINT_ID;
}
