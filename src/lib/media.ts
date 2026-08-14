/**
 * Recognising a URL that IS a media file, so it can be shown rather than linked.
 *
 * ⚠ EXTENSION ALLOWLIST, DELIBERATELY. Sniffing content-type would mean fetching
 * the URL from the browser before deciding how to render it, and post content is
 * attacker-supplied — that turns every reader into a request generator aimed at a
 * stranger's server. An extension is a weak signal, but the failure mode of
 * getting it wrong is a broken <img>, which the UI already handles.
 *
 * Formats are limited to what browsers actually decode natively. Adding `.mkv` or
 * `.flac` here would render a permanently broken player rather than a link that
 * at least works when clicked.
 */

const IMAGE_EXT = ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp"];
const VIDEO_EXT = ["mp4", "webm", "ogv", "mov"];
const AUDIO_EXT = ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac"];

export type MediaKind = "image" | "video" | "audio";

/**
 * What kind of media this URL points at, or null if it is an ordinary link.
 *
 * Only `https:` qualifies. An `http:` embed on an https page is blocked as mixed
 * content anyway, so rendering a player for one would produce a silent failure
 * instead of a working link.
 */
export function classifyMedia(rawUrl: string): MediaKind | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  // Extension comes from the PATH only — a query string can contain anything, and
  // `?redirect=x.png` must not turn an arbitrary endpoint into an <img>.
  const match = /\.([a-z0-9]+)$/i.exec(url.pathname);
  if (!match) return null;
  const ext = match[1].toLowerCase();

  if (IMAGE_EXT.includes(ext)) return "image";
  if (VIDEO_EXT.includes(ext)) return "video";
  if (AUDIO_EXT.includes(ext)) return "audio";
  return null;
}

/** The first media URL in a list, with its kind. */
export function firstMedia(urls: string[]): { url: string; kind: MediaKind } | null {
  for (const url of urls) {
    const kind = classifyMedia(url);
    if (kind) return { url, kind };
  }
  return null;
}
