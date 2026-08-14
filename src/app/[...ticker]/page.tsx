import { getBootboard, getPosts } from "../actions";
import { Feed } from "../Feed";

/**
 * Catch-all so ticker URLs survive a COLD LOAD.
 *
 * `/$openbook/$test` is produced client-side by `history.pushState`, which costs
 * no navigation and keeps the feed mounted (the whole reason `ThreadView` is an
 * overlay rather than a route). But a pushState URL is a real URL the moment
 * someone shares it, and without a route on this side the server would 404 the
 * link — which is the worst outcome, since the point of an addressable thread is
 * that it can be sent to someone.
 *
 * So this renders exactly the same page as `/`. `Feed` reads `location.pathname`
 * on mount and opens the named thread itself, which keeps ONE code path for
 * "which thread is open" instead of splitting it between server and client.
 *
 * Deliberately NOT a separate layout or a different component: any divergence
 * between this and `/` would show up only on shared links, i.e. exactly where it
 * would be least noticed and most damaging.
 */
export const revalidate = 10;

export default async function TickerPage() {
  const [posts, bootboard] = await Promise.all([getPosts(), getBootboard()]);

  return (
    <div className="h-[100dvh] text-white overflow-hidden touch-pan-x touch-pan-y overscroll-none bg-black">
      <Feed posts={posts} bootboard={bootboard} />
    </div>
  );
}
