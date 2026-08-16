import { describe, expect, it } from "vitest";
import { classifyMedia, downloadUrl, firstMedia, isSelfHostedMedia } from "./media";

describe("PDF", () => {
  it("is recognised so a post can show a document rather than a bare link", () => {
    expect(classifyMedia("https://x.com/paper.pdf")).toBe("pdf");
    expect(classifyMedia("https://x.com/PAPER.PDF")).toBe("pdf");
  });

  it("is still refused over plain http, like every other embed", () => {
    expect(classifyMedia("http://x.com/paper.pdf")).toBeNull();
  });

  it("cannot be faked by a query string", () => {
    // The extension comes from the PATH, so `?x=.pdf` must not turn an
    // arbitrary endpoint into a framed document.
    expect(classifyMedia("https://x.com/endpoint?file=a.pdf")).toBeNull();
  });
});

describe("downloadUrl", () => {
  const hash = "a".repeat(64);

  it("offers a save link for files we host", () => {
    expect(downloadUrl(`https://openbooks.space/m/${hash}.pdf`)).toBe(
      `https://openbooks.space/m/${hash}.pdf?download=1`
    );
  });

  it("returns null for a stranger's file, because `download` is ignored cross-origin", () => {
    // A Save button that silently opens a tab instead is worse than no button.
    expect(downloadUrl("https://example.com/paper.pdf")).toBeNull();
  });

  it("returns null for junk instead of throwing", () => {
    for (const bad of ["", "not a url", "/m/abc.pdf"]) {
      expect(downloadUrl(bad)).toBeNull();
    }
  });
});

describe("classifyMedia", () => {
  it.each([
    ["https://x.com/a.jpg", "image"],
    ["https://x.com/a.PNG", "image"],
    ["https://x.com/deep/path/photo.webp", "image"],
    ["https://x.com/clip.mp4", "video"],
    ["https://x.com/clip.webm", "video"],
    ["https://x.com/track.mp3", "audio"],
    ["https://x.com/track.m4a", "audio"],
  ])("classifies %s as %s", (url, kind) => {
    expect(classifyMedia(url)).toBe(kind);
  });

  it("returns null for an ordinary page", () => {
    expect(classifyMedia("https://example.com/article")).toBeNull();
    expect(classifyMedia("https://github.com/b0ase/openbook")).toBeNull();
  });

  it("refuses http — an embed would be blocked as mixed content anyway", () => {
    // Rendering a player that can never load is worse than rendering a link.
    expect(classifyMedia("http://x.com/a.jpg")).toBeNull();
  });

  it("takes the extension from the PATH, never the query string", () => {
    // Otherwise `?next=x.png` turns an arbitrary endpoint into an <img>.
    expect(classifyMedia("https://x.com/redirect?to=evil.png")).toBeNull();
    expect(classifyMedia("https://x.com/a.jpg?w=100")).toBe("image");
  });

  it("ignores formats browsers cannot decode natively", () => {
    // A player for these would be permanently broken; a link at least works.
    expect(classifyMedia("https://x.com/movie.mkv")).toBeNull();
    expect(classifyMedia("https://x.com/archive.zip")).toBeNull();
  });

  it("returns null for junk input", () => {
    expect(classifyMedia("not a url")).toBeNull();
    expect(classifyMedia("")).toBeNull();
  });
});

describe("firstMedia", () => {
  it("picks the first media link, skipping ordinary ones", () => {
    expect(
      firstMedia(["https://example.com/page", "https://x.com/a.png", "https://x.com/b.mp4"])
    ).toEqual({ url: "https://x.com/a.png", kind: "image" });
  });

  it("returns null when nothing is media", () => {
    expect(firstMedia(["https://example.com/page"])).toBeNull();
    expect(firstMedia([])).toBeNull();
  });
});

describe("isSelfHostedMedia", () => {
  it("recognises an upload this platform stored", () => {
    const hash = "f".repeat(64);
    expect(isSelfHostedMedia(`https://openbooks.space/m/${hash}.mp4`)).toBe(true);
    expect(isSelfHostedMedia(`https://openbooks.space/m/${hash}.png`)).toBe(true);
  });

  it("does NOT claim a stranger's file", () => {
    // The whole point of the split: someone else's server keeps preload="none",
    // so scrolling a feed cannot run up their bandwidth bill.
    expect(isSelfHostedMedia("https://example.com/video.mp4")).toBe(false);
    expect(isSelfHostedMedia("https://example.com/m/short.mp4")).toBe(false);
    expect(isSelfHostedMedia("https://openbooks.space/uploads/thing.mp4")).toBe(false);
  });

  it("is matched on SHAPE, so it resolves identically on server and client", () => {
    // A host comparison would need `window`, which does not exist during server
    // rendering — the two sides would disagree and React would report a
    // hydration mismatch.
    const hash = "a".repeat(64);
    expect(isSelfHostedMedia(`https://any-mirror.example/m/${hash}.webm`)).toBe(true);
  });

  it("returns false for junk instead of throwing", () => {
    for (const bad of ["", "not a url", "/m/abc.mp4"]) {
      expect(isSelfHostedMedia(bad)).toBe(false);
    }
  });
});
