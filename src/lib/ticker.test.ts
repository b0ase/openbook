/**
 * The ticker parse rule.
 *
 * Weighted deliberately toward what must NOT parse. Under the token model a
 * ticker is a claim that costs money, so a false positive is a transaction the
 * author never asked for, while a false negative is only a missing link.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalTicker,
  distinctTickers,
  findTickers,
  isValidTicker,
  LEGACY_ROOT_TICKER,
  leaderboardHref,
  parseTickerPath,
  ROOT_HREF,
  ROOT_TICKER,
  tickerHref,
} from "./ticker";

const symbols = (s: string) => findTickers(s).map((t) => t.symbol);

describe("what is NOT a ticker", () => {
  it.each([
    ["$50", "a plain price"],
    ["$1.50", "a decimal price"],
    ["$0", "zero"],
    ["it cost $20 today", "a price mid-sentence"],
    ["US$20", "a currency-prefixed price"],
    ["foo$bar", "mid-word"],
    ["$", "a bare dollar sign"],
    ["$$", "doubled"],
    ["$$OpenBook", "doubled before a word"],
    ["price: $ 20", "a space after the sign"],
  ])("%j — %s", (input) => {
    expect(symbols(input)).toEqual([]);
  });

  it("does not treat a price as a claim even beside a real ticker", () => {
    // The whole point: one post can contain both, and only one is a claim.
    expect(symbols("$OpenBook is worth more than $50")).toEqual(["OPENBOOK"]);
  });
});

describe("what IS a ticker", () => {
  it("matches a simple ticker", () => {
    expect(symbols("$OpenBook")).toEqual(["OPENBOOK"]);
  });

  it("matches mid-sentence and at the end", () => {
    expect(symbols("I think $NewIdea is the one")).toEqual(["NEWIDEA"]);
    expect(symbols("my favourite is $NewIdea")).toEqual(["NEWIDEA"]);
  });

  it("allows digits after the first letter", () => {
    expect(symbols("$Web3 and $B2B")).toEqual(["WEB3", "B2B"]);
  });

  it("matches after punctuation", () => {
    expect(symbols("(see $OpenBook) and, $Other.")).toEqual(["OPENBOOK", "OTHER"]);
  });

  it("stops at the length cap", () => {
    // 16 chars is the cap; the 17th is not consumed, and the \b then fails.
    expect(symbols(`$${"A".repeat(16)}`)).toEqual(["A".repeat(16)]);
    expect(symbols(`$${"A".repeat(17)}`)).toEqual([]);
  });
});

describe("canonical form", () => {
  it("is case-insensitive — the same name is the same claim", () => {
    // Case-sensitive tickers would allow a visually identical second claim,
    // which is the impersonation risk the app has to close.
    expect(symbols("$openbook $OpenBook $OPENBOOK")).toEqual(["OPENBOOK", "OPENBOOK", "OPENBOOK"]);
  });

  it("preserves the author's casing for display", () => {
    expect(findTickers("$OpenBook").map((t) => t.raw)).toEqual(["OpenBook"]);
  });

  it("strips a leading $ if one is passed", () => {
    expect(canonicalTicker("$abc")).toBe("ABC");
    expect(canonicalTicker("abc")).toBe("ABC");
  });
});

describe("distinctTickers", () => {
  it("counts one mention per post, however many times it appears", () => {
    expect(distinctTickers("$X and $X and $x again")).toEqual(["X"]);
  });

  it("preserves first-appearance order", () => {
    expect(distinctTickers("$Beta then $Alpha then $Beta")).toEqual(["BETA", "ALPHA"]);
  });

  it("returns nothing for content with no tickers", () => {
    expect(distinctTickers("just a normal post about $5 coffee")).toEqual([]);
  });
});

describe("positions", () => {
  it("reports offsets a renderer can slice on without re-scanning", () => {
    const content = "buy $OpenBook now";
    const [t] = findTickers(content);
    expect(content.slice(t.start, t.end)).toBe("$OpenBook");
  });

  it("is stable across repeated calls (no shared regex state)", () => {
    // A module-level /g regex carries lastIndex between calls, which would make
    // results depend on call order. Same input must always give same output.
    const content = "$A and $B";
    expect(symbols(content)).toEqual(symbols(content));
    expect(symbols(content)).toEqual(["A", "B"]);
  });
});

describe("isValidTicker", () => {
  it.each([["OPENBOOK"], ["A"], ["WEB3"], ["A".repeat(16)]])("accepts %j", (s) => {
    expect(isValidTicker(s)).toBe(true);
  });

  it.each([
    ["openbook"],
    ["3WEB"],
    [""],
    ["A".repeat(17)],
    ["OPEN_BOOK"],
    ["OPEN-BOOK"],
  ])("rejects %j", (s) => {
    expect(isValidTicker(s)).toBe(false);
  });
});

/**
 * The root's address is the bare site.
 *
 * `openbooks.space` and `openbooks.space/$openbooks` were both the front page,
 * and closing any thread parked you on the second one — so the domain someone
 * was given stopped matching the domain they were looking at. `tickerHref` is
 * the single minting point that keeps `/$openbooks` from being produced at all.
 */
describe("tickerHref", () => {
  it("sends the root to the bare site, not /$openbooks", () => {
    expect(tickerHref([ROOT_TICKER])).toBe(ROOT_HREF);
    expect(ROOT_HREF).toBe("/");
  });

  it("sends the pre-plural root home too", () => {
    expect(tickerHref([LEGACY_ROOT_TICKER])).toBe(ROOT_HREF);
  });

  it("treats an empty path as the root", () => {
    expect(tickerHref([])).toBe(ROOT_HREF);
  });

  it("keeps the root as an ANCESTOR — only the leaf decides the address", () => {
    expect(tickerHref([ROOT_TICKER, "TEST"])).toBe("/$openbooks/$test");
    expect(tickerHref([ROOT_TICKER, "FOXTROT", "GOLF"])).toBe("/$openbooks/$foxtrot/$golf");
  });

  it("addresses an ordinary ticker by its whole path", () => {
    expect(tickerHref(["TEST"])).toBe("/$test");
  });
});

describe("parseTickerPath", () => {
  // Untested until 2026-08-15, which is how the bug below survived: it is the
  // function every URL goes through — the leaderboard's route params, the
  // feed's popstate handler, the cold load of a shared thread link.

  it("reads a path", () => {
    expect(parseTickerPath("/$openbooks/$test")).toEqual([ROOT_TICKER, "TEST"]);
    expect(parseTickerPath("/$test")).toEqual(["TEST"]);
  });

  it("⚠ DECODES BEFORE TESTING FOR THE $, not after", () => {
    // The whole bug. `$` is a legal path character so it usually survives a URL
    // intact — but Next hands route params percent-encoded, and the filter ran
    // on the RAW segment: `%24work` failed `startsWith("$")` and was dropped
    // before anything decoded it. `/leaderboard/$work` 404'd as a name nobody
    // had ever written, for every ticker on the board.
    expect(parseTickerPath("/%24work")).toEqual(["WORK"]);
    expect(parseTickerPath("/%24openbooks/%24test")).toEqual([ROOT_TICKER, "TEST"]);
    expect(parseTickerPath("/$openbooks/%24test")).toEqual([ROOT_TICKER, "TEST"]);
  });

  it("round-trips what leaderboardHref and tickerHref emit, encoded or not", () => {
    // The two directions must agree — a link the app writes has to parse back
    // to the name it was written for, however the browser chose to escape it.
    const path = [ROOT_TICKER, "MEMEPLEX"];
    expect(parseTickerPath(leaderboardHref(path).replace("/leaderboard", ""))).toEqual(path);
    expect(parseTickerPath(tickerHref(path))).toEqual(path);
    expect(parseTickerPath(tickerHref(path).replaceAll("$", "%24"))).toEqual(path);
  });

  it("ignores segments that are not tickers", () => {
    expect(parseTickerPath("/leaderboard/$test")).toEqual(["TEST"]);
    expect(parseTickerPath("/")).toEqual([]);
    expect(parseTickerPath("/about/contact")).toEqual([]);
  });

  it("does not admit a price or a bare $ through the path either", () => {
    // The consensus parse rule decides here as everywhere else — a URL is not a
    // second place where `$50` becomes a ticker.
    expect(parseTickerPath("/$50")).toEqual([]);
    expect(parseTickerPath("/$")).toEqual([]);
    expect(parseTickerPath("/%2450")).toEqual([]);
  });

  it("survives a malformed escape instead of throwing", () => {
    // ⚠ `decodeURIComponent` throws on `%zz` or a lone `%`, and a URL is
    // attacker-supplied — an uncaught throw turns a junk address into a server
    // error rather than a page that simply names no ticker.
    expect(() => parseTickerPath("/%zz")).not.toThrow();
    expect(parseTickerPath("/%zz")).toEqual([]);
    expect(parseTickerPath("/%")).toEqual([]);
    expect(parseTickerPath("/$test/%e0%a4%a")).toEqual(["TEST"]);
  });
});
