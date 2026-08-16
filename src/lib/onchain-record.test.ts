import { describe, expect, it } from "vitest";
import {
  isOurRecord,
  ONCHAIN_APP,
  ONCHAIN_APP_HISTORY,
  ONCHAIN_RECORD_VERSION,
  onchainRecord,
} from "./onchain-record";

describe("onchainRecord", () => {
  it("wraps a body in the shared v / app / type / …body / ts envelope", () => {
    const p = JSON.parse(onchainRecord("post", { content: "hi", author: "anon" }));
    expect(p.v).toBe(ONCHAIN_RECORD_VERSION);
    expect(p.app).toBe(ONCHAIN_APP);
    // Hardcoded on purpose: this is an IRREVERSIBLE on-chain identifier, so it
    // should take a deliberate test edit to change, never drift silently with
    // the constant. bsvibes → opencook (Phase-7) → openbook (2026-08-16).
    expect(p.app).toBe("openbook");
    expect(p.type).toBe("post");
    expect(p.content).toBe("hi");
    expect(p.author).toBe("anon");
    expect(typeof p.ts).toBe("number");
  });

  it("still recognises records written under every previous name", () => {
    // 2,081 records are inscribed under "opencook" and cannot be rewritten. A
    // reader keying on the CURRENT literal alone would go blind to all of them.
    for (const app of ONCHAIN_APP_HISTORY) expect(isOurRecord(app)).toBe(true);
    expect(isOurRecord(ONCHAIN_APP)).toBe(true);
    expect(isOurRecord("opencook")).toBe(true);
    expect(isOurRecord("bsvibes")).toBe(true);
  });

  it("does not claim somebody else's records", () => {
    for (const other of ["twetch", "openbooks", "OpenBook", "", null, undefined, 7, {}]) {
      expect(isOurRecord(other)).toBe(false);
    }
  });

  it("orders envelope fields as v, app, type, …body, ts", () => {
    const keys = Object.keys(JSON.parse(onchainRecord("boot_split", { post_id: 1, booter: "a" })));
    expect(keys).toEqual(["v", "app", "type", "post_id", "booter", "ts"]);
  });
});
