/**
 * Recognise a YouTube link so it can be played inline.
 *
 * ⚠ THE HOST IS MATCHED EXACTLY, NEVER BY SUBSTRING. An iframe can execute
 * script, unlike the images and videos this app already embeds — so the check
 * that decides whether to frame a page is a security boundary, not a
 * convenience. `evil.com/youtube.com/watch?v=x` and `notyoutube.com` must both
 * fail, and a substring or `endsWith` test would pass at least one of them.
 *
 * Video IDs are matched strictly (`[A-Za-z0-9_-]{11}`) rather than "whatever
 * follows the slash", so a crafted path cannot smuggle characters into the
 * embed URL we build.
 */

const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

const ID = /^[A-Za-z0-9_-]{11}$/;

/** The 11-character video id, or null if this is not a YouTube video link. */
export function parseYouTubeId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  // http would be blocked as mixed content on an https page anyway, and we do
  // not want to advertise an insecure embed.
  if (url.protocol !== "https:") return null;
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;

  // youtu.be/<id>
  if (url.hostname.toLowerCase().endsWith("youtu.be")) {
    const id = url.pathname.slice(1).split("/")[0];
    return ID.test(id) ? id : null;
  }

  // youtube.com/watch?v=<id>
  const v = url.searchParams.get("v");
  if (v && ID.test(v)) return v;

  // youtube.com/{embed,shorts,live,v}/<id>
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && ["embed", "shorts", "live", "v"].includes(parts[0])) {
    return ID.test(parts[1]) ? parts[1] : null;
  }

  return null;
}

/**
 * The URL to frame.
 *
 * `youtube-nocookie.com` rather than `youtube.com`: it is YouTube's own
 * privacy-preserving host and it does not set tracking cookies until the viewer
 * actually presses play. Scrolling past a post should not enrol the reader in
 * anything.
 */
export function youTubeEmbedUrl(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}`;
}

/** The first YouTube video in a list of URLs. */
export function firstYouTube(urls: string[]): { url: string; id: string } | null {
  for (const url of urls) {
    const id = parseYouTubeId(url);
    if (id) return { url, id };
  }
  return null;
}
