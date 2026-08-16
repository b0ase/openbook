import { describe, expect, it } from "vitest";
import { bootAuditPayload } from "./boot-audit";

describe("bootAuditPayload", () => {
  it("emits the harmonized v:1 boot_split envelope with booter + funded (client path)", () => {
    const p = JSON.parse(
      bootAuditPayload({ postId: 7, booter: "1BooterAddr", funded: "booter", total: 1234 })
    );
    expect(p.v).toBe(1);
    expect(p.app).toBe("openbook");
    expect(p.type).toBe("boot_split");
    expect(p.post_id).toBe(7);
    expect(p.booter).toBe("1BooterAddr");
    expect(p.funded).toBe("booter");
    expect(p.total).toBe(1234);
    expect(typeof p.ts).toBe("number");
    // The client path doesn't know these — they must be omitted, not fabricated.
    expect(p.recipients).toBeUndefined();
    expect(p.formula_version).toBeUndefined();
  });

  it("includes recipients + formula_version for the server-funded path", () => {
    const p = JSON.parse(
      bootAuditPayload({
        postId: 1,
        booter: "1ServerBooter",
        funded: "server",
        total: 1000,
        recipients: 3,
        formulaVersion: "0.1.0",
      })
    );
    expect(p.funded).toBe("server");
    expect(p.recipients).toBe(3);
    expect(p.formula_version).toBe("0.1.0");
  });

  it("uses ONE consistent type discriminator for both funded modes (no drift)", () => {
    const server = JSON.parse(
      bootAuditPayload({ postId: 1, booter: "a", funded: "server", total: 1 })
    );
    const booter = JSON.parse(
      bootAuditPayload({ postId: 1, booter: "a", funded: "booter", total: 1 })
    );
    expect(server.type).toBe("boot_split");
    expect(booter.type).toBe("boot_split");
  });
});
