import { ShieldCheck } from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Dashboard } from "@/components/triage/dashboard";
import { LiveStatus } from "@/components/triage/live";
import { FxToggle, RefreshButton } from "@/components/triage/refresh-button";
import { RefreshFx } from "@/components/triage/refresh-fx";

export function App() {
  return (
    <RefreshFx>
    <div className="mx-auto max-w-[1440px] space-y-3 px-4 py-4">
      <a
        href="#panels"
        className="sr-only rounded-md bg-foreground px-3 py-1.5 text-sm font-medium text-background focus:not-sr-only focus:fixed focus:top-3 focus:left-4 focus:z-50"
      >
        Skip to panels
      </a>
      <header className="flex items-center gap-2">
        <ShieldCheck aria-hidden className="size-5" />
        <h1 className="text-base font-semibold tracking-tight whitespace-nowrap">GitHub Triage</h1>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <LiveStatus />
          <RefreshButton />
          <FxToggle />
          <ThemeToggle />
        </div>
      </header>
      <main>
        <Dashboard />
      </main>
    </div>
    </RefreshFx>
  );
}
