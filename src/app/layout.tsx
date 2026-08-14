import type { Metadata, Viewport } from "next";
import { Caveat, Geist, Geist_Mono } from "next/font/google";
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
  title: "$OpenBook — A platform that builds itself",
  description:
    "Post ideas, boot the best ones to the top, earn value through contribution. Agentic fairness on BSV.",
  // ⚠ Describes what is LIVE. No claim that a token exists — the share card is the
  // least questionable surface the project has, so the manifesto's tense rule
  // applies hardest here.
  openGraph: {
    title: "$OpenBook — an open book of who built what",
    description:
      "Post an idea and it's timestamped on-chain, permanently. Boost a post and the payment splits straight to contributors in one transaction — no balances held, no IOUs.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "$OpenBook — an open book of who built what",
    description:
      "Every post anchored on-chain. Every boost split straight to contributors in a single transaction.",
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
