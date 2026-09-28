import { ShieldCheck } from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Account, ApiBudgets, Dashboard } from "@/components/triage/dashboard";
import { LiveAnnouncer, LiveStatus, NewVersion } from "@/components/triage/live";
import { NotificationsToggle } from "@/components/triage/notifications";
import { FxToggle, RefreshButton } from "@/components/triage/refresh-button";
import { RefreshFx } from "@/components/triage/refresh-fx";
import { openShortcuts, Shortcuts } from "@/components/triage/shortcuts";

export function App() {
  return (
    <RefreshFx>
      {/* At least a screen tall, so the status bar sits at the bottom even when the board is short. */}
      <div className="mx-auto flex min-h-dvh max-w-[1440px] flex-col gap-3 px-4 pt-4">
        <a
          href="#panels"
          className="sr-only rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-50"
        >
          Skip to panels
        </a>
        <header className="flex items-center gap-2">
          <ShieldCheck aria-hidden className="size-5" />
          <h1 className="text-base font-semibold tracking-tight whitespace-nowrap">GitHub Triage</h1>
          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            <NewVersion />
            <LiveStatus />
            <RefreshButton />
            <ThemeToggle />
            <Account />
          </div>
        </header>
        <main className="flex-1">
          <Dashboard />
        </main>
        {/* A status bar: preferences and diagnostics, always in reach but never what you came to look at.
            Sticky, so it stays pinned to the bottom of the screen while the board scrolls under it. */}
        <footer className="sticky bottom-0 z-10 -mx-4 flex h-8 items-center gap-x-4 overflow-x-auto border-t bg-background px-4 text-xs whitespace-nowrap text-muted-foreground">
          <button type="button" onClick={openShortcuts} className="-my-1 py-1 hover:text-foreground">
            Shortcuts and colours{" "}
            <kbd className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded border bg-muted px-1 font-mono text-[10px] text-foreground">
              ?
            </kbd>
          </button>
          <FxToggle />
          <NotificationsToggle />
          {/* No room on phones; the context line still shows a budget once it runs low. */}
          <span className="ml-auto hidden sm:inline">
            <ApiBudgets />
          </span>
        </footer>
      </div>
      <Shortcuts />
      <LiveAnnouncer />
    </RefreshFx>
  );
}
