import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppProviders } from "@/components/AppProviders";
import { BottomNav } from "@/components/BottomNav";
import { SiteNav } from "@/components/SiteNav";
import { siteOrigin } from "@/lib/site-origin";
import { getServerAddress } from "@/services/bsv/wallet";
import { getPostById } from "../../actions";
import { PermalinkThread } from "./PermalinkThread";

/**
 * A single post, at its own URL.
 *
 * ⚠ EVERY POST NEEDS ONE, and until now none had. The only way to reach a post
 * was to scroll a feed to it — so a board whose entire claim is *own what you
 * post* gave you nothing to link to. You owned it and could not point at it.
 *
 * ⚠ THIS IS ALSO THE SHARING SURFACE. A link pasted into Telegram or X has to
 * unfurl into something a stranger can read without an account, which is what
 * `generateMetadata` below is for: the post's own text as the description, so the
 * preview card carries the words rather than a generic site blurb. That is the
 * difference between sharing a post and sharing a homepage.
 *
 * Dynamic, not static: posts arrive constantly and a build-time render would
 * freeze whatever existed when the container was built (see `/chat`, which
 * shipped an empty list for exactly that reason).
 */
export const dynamic = "force-dynamic";

/** Trim to something that reads as a sentence in a preview card. */
function excerpt(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const post = await getPostById(Number(id));
  if (!post) return { title: "Post not found — $OpenBooks" };

  const who = post.author_nym ? `$${post.author_nym}` : post.author_name;
  const body = excerpt(post.content);
  // The TITLE is the author, the DESCRIPTION is what they said. A card titled
  // with the post text and described with boilerplate reads as a site link; this
  // way round reads as a quote from a person, which is what it is.
  return {
    title: `${who} on $OpenBooks`,
    description: body,
    openGraph: {
      title: `${who} on $OpenBooks`,
      description: body,
      url: `${siteOrigin()}/p/${post.id}`,
      images: [`${siteOrigin()}/og-openbooks.jpg`],
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title: `${who} on $OpenBooks`,
      description: body,
    },
  };
}

export default async function PostPermalink({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const post = await getPostById(Number(id));
  if (!post) notFound();

  return (
    <AppProviders>
      <div className="flex h-[100dvh] flex-col bg-black text-white">
        <SiteNav supportAddress={getServerAddress()} />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
          <PermalinkThread post={post} />
        </div>
        <BottomNav />
      </div>
    </AppProviders>
  );
}
