"use client";

import { IdentityChip } from "@/app/IdentityBar";

/**
 * The wallet chip, for pages that are not the feed.
 *
 * ⚠ THE CHIP BELONGS ON EVERY PAGE THE USER CAN REACH, because it is about THEM
 * and not about the page. It only ever rendered inside the feed, so following a
 * link to `/market` or a leaderboard dropped the user's balance, their name and
 * their way into their own wallet — on exactly the pages that talk about what
 * they hold. A wallet you can only see on the front page is a wallet you have to
 * navigate away from your holdings to check.
 *
 * ⚠ IT NO LONGER MOUNTS ITS OWN PROVIDERS. It used to, so that a standalone page
 * could show the chip with no setup. That broke the moment a page needed identity
 * for anything else as well: two `IdentityProvider`s hold separate unlock
 * sessions, so signing in through the chip left a composer beside it still
 * locked. The stack lives in `AppProviders`, which every standalone page wraps
 * itself in — see the note there. Rendering this outside one is a bug, and React
 * will say so rather than failing quietly.
 *
 * `onOpenThread` is intentionally omitted — these pages have no thread overlay of
 * their own, and `IdentityChip` already renders those rows inert rather than
 * offering a control that goes nowhere.
 */
export function SiteIdentity() {
  return <IdentityChip />;
}
