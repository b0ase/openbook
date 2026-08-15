import type { Metadata, Viewport } from "next";
import { Caveat, Geist, Geist_Mono } from "next/font/google";
import { siteOrigin } from "@/lib/site-origin";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const caveat = Caveat({
  variable: "--font-caveat",
  subsets: ["latin"],
});

// Use Next.js Viewport API (canonical) so Next.js doesn't inject a
// competing default viewport meta tag. `interactiveWidget` only works
// on iOS Safari 16.4+; older versions silently fall back to default.
//
// themeColor is BLACK so the Safari iOS bottom URL bar is tinted black.
// The amber-at-top look is achieved via a body gradient (see globals.css)
// that paints amber in the env(safe-area-inset-top) zone — visible
// behind both the Safari iOS top chrome and the PWA translucent status
// bar.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#000000",
};

export const metadata: Metadata = {
  /**
   * ⚠ WITHOUT THIS, EVERY SOCIAL CARD IS BROKEN AND NOTHING SAYS SO. Next builds
   * absolute metadata URLs from the REQUEST HOST when no base is given, and
   * behind Railway's proxy that host is the internal `localhost:8080` — so
   * `og:image` was literally `http://localhost:8080/opengraph-image`, which no
   * scraper can fetch. Pages rendered, tags validated, and every shared link fell
   * back to whatever the scraper had cached. It failed silently and totally.
   *
   * `siteOrigin()` resolves SITE_ORIGIN → RAILWAY_PUBLIC_DOMAIN → localhost, so a
   * deploy is correct with no configuration and canonical once the domain is set.
   */
  metadataBase: new URL(siteOrigin()),
  /**
   * ⚠ INHERITED OPENCOOK COPY WAS REPLACED HERE, ON PURPOSE. This used to read
   * "A platform that builds itself / Agentic fairness on BSV". Both were wrong
   * for OpenBooks and the owner rejected them:
   *
   *  - "builds itself" is not true. Somebody has to BUILD the platform other
   *    people then use. Claiming otherwise is a slogan pretending to be a fact.
   *  - "fair" is not the pitch. Nobody is looking for a fair place to post; they
   *    want somewhere good, competitive and worth their time. Fairness describes
   *    the payout arithmetic, which is plumbing, not a reason to show up.
   *
   * The actual proposition is OWNERSHIP: you keep a piece of what you make.
   * Keep this line pointed at that, and keep it to things that are live.
   */
  title: "$OpenBook — own what you post",
  description:
    "Post an idea and it's yours: timestamped on-chain, and it mints you a token in the thread it starts. Boost the ones worth reading and the payment goes straight to whoever wrote them.",
  // ⚠ Describes what is LIVE, and leads with OWNERSHIP rather than fairness —
  // see the note on `title` above. The line is token vs market (TOKENS.md): the
  // card MAY say a post mints a token you own, and may NOT say it is buyable or
  // worth money. This is the least questionable surface the project has, so that
  // rule applies hardest here.
  openGraph: {
    title: "$OpenBook — own what you post",
    description:
      "Post an idea and it's yours: timestamped on-chain, permanently, and it mints you a token in the thread it starts. Boost the ones worth reading and the payment splits straight to whoever wrote them — no balances held, no IOUs.",
    type: "website",
    /**
     * ⚠ A STATIC PHOTO, AND `app/opengraph-image.tsx` WAS DELETED SO IT WINS.
     * A file-based OG image ALWAYS overrides `openGraph.images`, so the two
     * cannot coexist — re-adding that file silently takes this photo off every
     * share, with no error anywhere. The generated card it replaced rendered the
     * wordmark and positioning line as text inside the image; the real sign is
     * stronger at a glance, and the words still appear beside it as og:title and
     * og:description.
     *
     * CROPPED to fill 1200x630 from a 1728x1152 original, not padded.
     *
     * An earlier version letterboxed it on black. The bars were invisible
     * against the photograph, but Telegram (and any client that renders the card
     * at its own aspect) then showed a small image floating in a large frame. A
     * centre crop to 1728x907 keeps both the wordmark and the book mark inside —
     * checked, not assumed — so filling the frame costs nothing here. Re-crop
     * from the original if the image is ever replaced; do not scale this one up.
     */
    images: [
      {
        url: "/og-openbooks.jpg",
        width: 1200,
        height: 630,
        alt: "$OpenBooks",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "$OpenBook — own what you post",
    description:
      "Every post anchored on-chain, and one token to whoever wrote it. Boosts split straight to contributors in a single transaction.",
    images: ["/og-openbooks.jpg"],
  },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "$OpenBook",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
  // Search-engine indexing is OFF until ALLOW_INDEXING=true (early-access / quiet
  // launch — keeps a rough opencook.fun out of Google). Going public = set that
  // env var, no code change. See LAUNCH_CHECKLIST Stage 4. Kept in sync with
  // app/robots.ts.
  robots: process.env.ALLOW_INDEXING === "true" ? undefined : { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${caveat.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
