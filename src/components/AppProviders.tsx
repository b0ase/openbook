"use client";

import type { ReactNode } from "react";
import { BootProvider } from "@/contexts/BootContext";
import { IdentityProvider } from "@/contexts/IdentityContext";
import { InstallProvider } from "@/contexts/InstallContext";
import { InAppPromptModal } from "./InAppPromptModal";
import { SignInModal } from "./SignInModal";

/**
 * The provider stack for pages that are not the feed.
 *
 * ⚠ ONE STACK PER PAGE, AND THAT IS THE WHOLE POINT. `SiteIdentity` used to mount
 * its own providers so a standalone page could show a wallet chip without any
 * setup. That works right up until something ELSE on the page also needs identity
 * — as the Threads tab does, to know whose threads to list and to unlock a reply
 * composer. Two independent `IdentityProvider`s on one page read the same
 * localStorage, so it LOOKS fine, but they hold separate unlock sessions: signing
 * in via the chip would leave the composer beside it still locked, with nothing
 * on screen explaining why.
 *
 * So the providers moved up here and the chip became a plain consumer. A page
 * renders either the feed (which mounts its own stack in `Feed`) or this — never
 * both — so there is still exactly one identity context per tree.
 *
 * The modals come along because anything inside can open them: `requireIdentity()`
 * opens the sign-in modal, and a read-only in-app browser opens the explainer. A
 * gate that opens a modal nobody mounted is a dead control.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <BootProvider>
      <IdentityProvider>
        <InstallProvider>
          <SignInModal />
          <InAppPromptModal />
          {children}
        </InstallProvider>
      </IdentityProvider>
    </BootProvider>
  );
}
