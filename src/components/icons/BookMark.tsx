/**
 * The open book from the brand mark.
 *
 * ⚠ THE SAME TWO PATHS AS `public/icon.svg`, not a redrawing. That file is the
 * favicon, the PWA install icon and the iOS home-screen icon, so the glyph in
 * the tab bar and the glyph on the user's home screen are one shape — a second
 * drawing would drift and the app would stop looking like its own icon.
 *
 * Tight viewBox around the book alone (the source art sits inside a 512 medallion
 * with a `$` above it), so this scales to a 20px tab icon without the surrounding
 * dead space forcing the mark down to a few pixels.
 */
export function BookMark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size * (78 / 232)}
      viewBox="140 316 232 78"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      {/* Two pages sweeping up and out from a centre spine. The 10px centre gap
          is what separates them — without it the shapes read as one slab. */}
      <path d="M251 352 L140 316 L140 358 L251 394 Z" />
      <path d="M261 352 L372 316 L372 358 L261 394 Z" />
    </svg>
  );
}
