/**
 * The one address of a single post.
 *
 * ⚠ ONE PLACE, because the address is written from three sides and read from a
 * fourth: the timestamp link and the copy button in `PostContent`, the
 * `pushState` that makes an open thread addressable in `Feed`, and the
 * `popstate` handler that has to recognise the URL coming back. A hand-built
 * `/p/${id}` in any one of them is a second definition waiting to disagree with
 * the route — the same shape of bug that put `/$openbooks` in the address bar
 * (see `tickerHref`).
 *
 * Pure and dependency-free so the route, the client and any test can share it.
 */
export function postHref(id: number): string {
  return `/p/${id}`;
}

/**
 * `/p/123` → `123`. Anything else → `null`.
 *
 * Strict on purpose: this decides whether a URL arriving from history means "a
 * post is open". `/p/12/extra`, `/p/abc`, `/p/-1` and `/products/1` are all
 * NOT a post, and a loose parse would reopen an overlay over the wrong page —
 * or, worse, pass a non-number to a query.
 */
export function parsePostHref(pathname: string): number | null {
  const m = /^\/p\/(\d+)$/.exec(pathname);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The absolute link a reader can paste elsewhere.
 *
 * Takes the origin rather than reading `window`, so it stays pure and the
 * caller decides (browser: `window.location.origin`; server: `siteOrigin()`).
 */
export function postUrl(origin: string, id: number): string {
  return `${origin.replace(/\/+$/, "")}${postHref(id)}`;
}
