/**
 * How a share of a thread is written as a percentage.
 *
 * ⚠ ONE FORMATTER, SHARED. The same figure appears in three places — the compose
 * hint, the thread header and the wallet — and three copies of "round it
 * sensibly" would eventually disagree by a digit on the same number. A reader
 * who sees 0.3% in one panel and 0.25% in another has no way to know which is
 * the real one, so they stop trusting both.
 *
 * Precision scales with smallness: whole numbers read cleanly at the top, and a
 * tiny holding still gets enough digits to be distinguishable from zero. A
 * holding that exists must never print "0%" — that reads as "you have nothing"
 * when the truth is "you have a little", which is the one error this display
 * cannot afford to make.
 */
export function formatShare(mine: number, total: number): string {
  if (!Number.isFinite(mine) || !Number.isFinite(total) || total <= 0 || mine <= 0) {
    return "0%";
  }
  const share = (mine / total) * 100;
  if (share >= 10) return `${share.toFixed(0)}%`;
  if (share >= 1) return `${share.toFixed(1)}%`;
  if (share >= 0.1) return `${share.toFixed(2)}%`;
  // Below 0.01% every remaining digit is noise; say "under" rather than print a
  // long decimal that implies precision the number does not carry.
  if (share < 0.01) return "<0.01%";
  return `${share.toFixed(3)}%`;
}
