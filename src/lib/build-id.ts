/**
 * Which build this code came from, and whether a running tab has fallen behind
 * the server.
 *
 * See the note on `BUILD_ID` in `next.config.ts` for why this is needed at all:
 * a tab open across a deploy keeps polling happily through its route handler
 * while every server action it knows about has been replaced, so the page looks
 * alive and every mutation fails.
 */

/**
 * Frozen into the client bundle at build time (via `env` in next.config.ts), and
 * on the server it is the running build. That asymmetry is the whole mechanism.
 */
export const CLIENT_BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";

/**
 * Whether a tab built at `clientBuildId` is older than the server now answering.
 *
 * ⚠ FALSE UNLESS WE ARE CERTAIN. This drives a banner telling the user to
 * reload, and a banner that cries wolf is worse than no banner — people learn to
 * dismiss it and then miss the real one. So anything ambiguous is treated as
 * "not stale":
 *  - `dev` on either side: local development rebuilds constantly and the ids are
 *    meaningless there.
 *  - a missing or non-string id from the server: an older server, a proxy that
 *    rewrote the body, or a route that has not been redeployed yet. None of
 *    those are evidence that the CLIENT is behind.
 */
export function isStaleBuild(serverBuildId: unknown, clientBuildId = CLIENT_BUILD_ID): boolean {
  if (typeof serverBuildId !== "string" || serverBuildId === "") return false;
  if (serverBuildId === "dev" || clientBuildId === "dev") return false;
  return serverBuildId !== clientBuildId;
}
