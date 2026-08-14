import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { siteOrigin } from "@/lib/site-origin";
import {
  canonicalTicker,
  isRootTicker,
  isValidTicker,
  ROOT_HREF,
  titleCaseTicker,
} from "@/lib/ticker";
import { getServerAddress } from "@/services/bsv/wallet";
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

/** The claim path a URL names, e.g. `["$openbooks","$test"]` → `["OPENBOOKS","TEST"]`. */
function pathFromParams(ticker: string[] | undefined): string[] {
  return (ticker ?? [])
    .map((seg) => canonicalTicker(decodeURIComponent(seg)))
    .filter(isValidTicker);
}

/**
 * `/$openbooks` is the site itself, so it belongs at `/`.
 *
 * The root token's thread and the main feed are one view, and `ROOT_HREF` picks
 * the address people actually type. Serving both would mean the domain someone
 * was given and the domain they end up on are different strings — so the longer
 * one redirects rather than rendering a second copy.
 *
 * Only a path whose LAST segment is the root redirects: that is the segment that
 * decides which thread opens, so `/$openbooks/$test` is `$Test` and stays put.
 *
 * TEMPORARY (307), not permanent: a 308 is cached by the browser indefinitely,
 * and `/$openbooks` is a name that can be reclaimed or re-pointed. Costing a
 * round trip on a URL nobody shares is the cheaper side of that trade.
 */
function redirectIfRoot(path: string[]): void {
  const leaf = path.at(-1);
  if (leaf && isRootTicker(leaf)) redirect(ROOT_HREF);
}

/**
 * Title, description and social card for a shared ticker link.
 *
 * Without these, a pasted ticker URL previewed as the generic site card and the
 * idea being pointed at was invisible — which defeats the point of an
 * addressable thread.
 *
 * ⚠ THE CARD IS `/api/og`, NOT AN `opengraph-image.tsx` FILE. This is a catch-all
 * route, and Next refuses a metadata file inside one — it is a BUILD failure
 * ("Catch-all must be the last part of the URL"), not a warning. Don't move it
 * back.
 *
 * The image URL must be ABSOLUTE: scrapers do not resolve relative paths, and
 * the request host is not a safe source for it — behind Railway's proxy that is
 * `localhost:8080`, which is how the root card ended up unfetchable. `siteOrigin()`
 * is the one resolver; see `lib/site-origin.ts`.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ ticker: string[] }>;
}): Promise<Metadata> {
  const { ticker } = await params;
  const path = pathFromParams(ticker);
  // The root redirects to `/`, whose own metadata is the one that should be read.
  redirectIfRoot(path);
  const leaf = path.at(-1);
  if (!leaf) return {};
  const name = `$${titleCaseTicker(leaf)}`;
  const title = `${name} — $OpenBooks`;
  const description = `${name} on $OpenBooks. Every post anchored on-chain, and one token to whoever wrote it.`;

  const slug = path.map((s) => `$${s.toLowerCase()}`).join("/");
  const image = `${siteOrigin()}/api/og?p=${encodeURIComponent(slug)}`;

  return {
    title,
    description,
    openGraph: { title, description, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export default async function TickerPage({ params }: { params: Promise<{ ticker: string[] }> }) {
  redirectIfRoot(pathFromParams((await params).ticker));

  const [posts, bootboard] = await Promise.all([getPosts(), getBootboard()]);
  // Derived from BSV_SERVER_WIF, never hardcoded — a key rotation must not leave a
  // dead address published.
  const supportAddress = getServerAddress();

  return (
    <div className="h-[100dvh] text-white overflow-hidden touch-pan-x touch-pan-y overscroll-none bg-black">
      <Feed posts={posts} bootboard={bootboard} supportAddress={supportAddress} />
    </div>
  );
}
