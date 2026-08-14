import type { Metadata } from "next";
import { canonicalTicker, isValidTicker, titleCaseTicker } from "@/lib/ticker";
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
 * The image URL must be ABSOLUTE: scrapers do not resolve relative paths. It is
 * built from `SITE_ORIGIN` for the same reason uploads are — a card URL is
 * fetched by third parties from wherever the link was shared, so it cannot
 * depend on which host served the page.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ ticker: string[] }>;
}): Promise<Metadata> {
  const { ticker } = await params;
  const path = (ticker ?? [])
    .map((seg) => canonicalTicker(decodeURIComponent(seg)))
    .filter(isValidTicker);
  const leaf = path.at(-1);
  if (!leaf) return {};
  const name = `$${titleCaseTicker(leaf)}`;
  const title = `${name} — $OpenBook`;
  const description = `${name} on $OpenBook. Every post anchored on-chain, and one token to whoever wrote it.`;

  const origin = (process.env.SITE_ORIGIN?.trim().replace(/\/+$/, "") ?? "").replace(/\/+$/, "");
  const slug = path.map((s) => `$${s.toLowerCase()}`).join("/");
  const image = `${origin}/api/og?p=${encodeURIComponent(slug)}`;

  return {
    title,
    description,
    // Omit images entirely when SITE_ORIGIN is unset rather than emitting a
    // relative URL a scraper cannot fetch — falling back to the site-wide card
    // is a worse preview, but a broken image is a worse one still.
    openGraph: { title, description, ...(origin ? { images: [image] } : {}) },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      ...(origin ? { images: [image] } : {}),
    },
  };
}

export default async function TickerPage() {
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
