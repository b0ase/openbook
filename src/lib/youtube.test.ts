/**
 * YouTube link recognition.
 *
 * Deciding to frame a page is a security boundary — an iframe can execute
 * script, unlike the images and videos already embedded here — so most of these
 * are look-alikes that must NOT match.
 */

import { describe, expect, it } from "vitest";
import { firstYouTube, parseYouTubeId, youTubeEmbedUrl } from "./youtube";

const ID = "RpSJZsE1fjI";

describe("parseYouTubeId", () => {
  it("reads every shape YouTube actually hands out", () => {
    expect(parseYouTubeId(`https://youtu.be/${ID}`)).toBe(ID);
    // The share link from the owner's own post — tracking params and all.
    expect(parseYouTubeId(`https://youtu.be/${ID}?si=bX8ltLt1WnVmSZ5o`)).toBe(ID);
    expect(parseYouTubeId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(parseYouTubeId(`https://m.youtube.com/watch?v=${ID}&t=42s`)).toBe(ID);
    expect(parseYouTubeId(`https://music.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(parseYouTubeId(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
    expect(parseYouTubeId(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
    expect(parseYouTubeId(`https://www.youtube.com/live/${ID}`)).toBe(ID);
  });

  it("REFUSES a host that merely contains or resembles youtube", () => {
    // The whole reason the host is matched exactly. A substring or endsWith
    // check would frame at least one of these.
    expect(parseYouTubeId(`https://notyoutube.com/watch?v=${ID}`)).toBeNull();
    expect(parseYouTubeId(`https://youtube.com.evil.test/watch?v=${ID}`)).toBeNull();
    expect(parseYouTubeId(`https://evil.test/youtube.com/watch?v=${ID}`)).toBeNull();
    expect(parseYouTubeId(`https://evil.test/?v=${ID}`)).toBeNull();
  });

  it("REFUSES an id that is not an id", () => {
    // Strict id matching stops a crafted path smuggling characters into the
    // embed URL we build.
    expect(parseYouTubeId("https://youtu.be/../../etc/passwd")).toBeNull();
    expect(parseYouTubeId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(parseYouTubeId(`https://www.youtube.com/watch?v=${ID}extra`)).toBeNull();
    expect(parseYouTubeId('https://youtu.be/"><script>')).toBeNull();
  });

  it("REFUSES http — an insecure embed on an https page is blocked anyway", () => {
    expect(parseYouTubeId(`http://www.youtube.com/watch?v=${ID}`)).toBeNull();
  });

  it("is null for non-video YouTube pages and for junk", () => {
    expect(parseYouTubeId("https://www.youtube.com")).toBeNull();
    expect(parseYouTubeId("https://www.youtube.com/@someone")).toBeNull();
    expect(parseYouTubeId("not a url")).toBeNull();
    expect(parseYouTubeId("")).toBeNull();
  });
});

describe("youTubeEmbedUrl", () => {
  it("frames the NO-COOKIE host", () => {
    // Scrolling past a post must not enrol the reader in tracking; nocookie
    // sets nothing until they press play.
    expect(youTubeEmbedUrl(ID)).toBe(`https://www.youtube-nocookie.com/embed/${ID}`);
  });
});

describe("firstYouTube", () => {
  it("picks the first real video and ignores the rest", () => {
    expect(
      firstYouTube([
        "https://example.com/not-a-video",
        `https://youtu.be/${ID}`,
        "https://www.youtube.com/watch?v=BBBBBBBBBBB",
      ])
    ).toEqual({ url: `https://youtu.be/${ID}`, id: ID });

    expect(firstYouTube(["https://example.com"])).toBeNull();
    expect(firstYouTube([])).toBeNull();
  });
});
