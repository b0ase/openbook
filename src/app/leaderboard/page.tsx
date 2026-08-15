import { redirect } from "next/navigation";
import { leaderboardHref, ROOT_TICKER } from "@/lib/ticker";

/**
 * `/leaderboard` on its own — the board's own token.
 *
 * ⚠ THIS EXISTS BECAUSE A CATCH-ALL MATCHES ONE SEGMENT OR MORE, NEVER ZERO.
 * `/leaderboard/[...ticker]` handles `/leaderboard/$memeplex` and nothing at
 * `/leaderboard`, so the bare path 404'd — an address people type, and the
 * obvious one to link, answering as though the page did not exist.
 *
 * It redirects rather than duplicating the board: one renderer, and the URL you
 * end on is the token you are actually looking at, so copying it out of the
 * address bar gives somebody the same page.
 */
export default function LeaderboardIndex() {
  redirect(leaderboardHref([ROOT_TICKER]));
}
