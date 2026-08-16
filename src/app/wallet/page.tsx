import type { Metadata } from "next";
import { WalletPanel } from "./WalletPanel";

/**
 * The Wallet tab.
 *
 * ⚠ IT OPENS THE WALLET THAT ALREADY EXISTS. Balance, all-time earnings, the
 * activity feed, deposit, recovery file and passphrase all live in `IdentityBar`'s
 * modal. A tab that reimplemented any of that would be a second surface telling
 * people what they hold, and the two would eventually disagree — which, on a
 * board about ownership, is the worst thing to be vague about.
 */
export const metadata: Metadata = {
  title: "Wallet — $OpenBooks",
  description: "Your balance, what you have earned, and your recovery file.",
};

export default function WalletPage() {
  return <WalletPanel />;
}
