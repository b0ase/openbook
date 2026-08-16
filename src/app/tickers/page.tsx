import { permanentRedirect } from "next/navigation";

/**
 * `/tickers` is now `/market`.
 *
 * ⚠ A REDIRECT, NOT A DELETED PAGE. This URL is in the wild — it is linked from
 * `SiteNav`, from posts, and from anywhere anyone has shared the index. The board
 * is built on the idea that what you post is permanent, so quietly 404ing a URL
 * it printed is the wrong shape of change even for our own pages.
 *
 * `permanentRedirect` (308) rather than a temporary one: the index has genuinely
 * moved, and telling crawlers so is what stops the old URL competing with the new
 * one in an index the whole page exists to reach.
 *
 * The page itself lives in `app/market/page.tsx`; there is no second copy here.
 */
export default function TickersPage(): never {
  permanentRedirect("/market");
}
