import { getServerAddress } from "@/services/bsv/wallet";
import { getBootboard, getPosts } from "./actions";
import { Feed } from "./Feed";

// Static/ISR (cached) — in-app-browser handling is now entirely CLIENT-SIDE.
// Telegram's iOS UA is byte-identical to Safari, so the server can't detect it;
// `IdentityContext` detects in-app WebViews on the client (via
// `window.TelegramWebviewProxy` + UA) and puts the feed into read-only mode.
// So this page no longer reads request headers and is edge-cacheable again —
// which matters for link-preview crawlers on a share-driven launch. See
// DECISIONS "In-app browsers ... read-only live feed".
export const revalidate = 10;

export default async function Home() {
  const [posts, bootboard] = await Promise.all([getPosts(), getBootboard()]);
  // Derived from BSV_SERVER_WIF, never hardcoded — a key rotation must not leave a
  // dead address published.
  const supportAddress = getServerAddress();

  return (
    // Fully black background (combines with themeColor "#000000" so both the
    // iOS PWA status-bar zone and Safari's URL bar read black).
    <div className="h-[100dvh] text-white overflow-hidden touch-pan-x touch-pan-y overscroll-none bg-black">
      <Feed posts={posts} bootboard={bootboard} supportAddress={supportAddress} />
    </div>
  );
}
