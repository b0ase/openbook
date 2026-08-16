import { describe, expect, it } from "vitest";
import { isStaleBuild } from "./build-id";

describe("isStaleBuild", () => {
  it("flags a tab older than the server", () => {
    expect(isStaleBuild("build-b", "build-a")).toBe(true);
  });

  it("does not flag a tab on the current build", () => {
    expect(isStaleBuild("build-a", "build-a")).toBe(false);
  });

  // Everything below is about NOT crying wolf. The banner asks the user to
  // reload; if it appears when nothing is wrong, people learn to ignore it and
  // then miss the real one.
  it("stays quiet in local development, where ids churn constantly", () => {
    expect(isStaleBuild("dev", "dev")).toBe(false);
    expect(isStaleBuild("dev", "build-a")).toBe(false);
    expect(isStaleBuild("build-a", "dev")).toBe(false);
  });

  it("stays quiet when the server said nothing", () => {
    // An older server, a route not yet redeployed, or a proxy that rewrote the
    // body. None of these are evidence the CLIENT is behind.
    for (const missing of [undefined, null, "", 0, false, {}, []]) {
      expect(isStaleBuild(missing, "build-a")).toBe(false);
    }
  });

  it("treats the build id as opaque", () => {
    // No ordering, no parsing — a deploy can roll back, and "different" is the
    // only claim being made.
    expect(isStaleBuild("2", "10")).toBe(true);
    expect(isStaleBuild("a1b2c3d4e5f6", "f6e5d4c3b2a1")).toBe(true);
  });
});
