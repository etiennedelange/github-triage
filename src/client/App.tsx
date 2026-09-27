import { ShieldCheck } from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Dashboard } from "@/components/triage/dashboard";
import { LiveStatus } from "@/components/triage/live";
import { FxPicker, RefreshButton } from "@/components/triage/refresh-button";
import { RefreshFx } from "@/components/triage/refresh-fx";

export function App() {
  return (
    <RefreshFx>
    <div className="mx-auto max-w-[1440px] space-y-3 px-4 py-4">
      <header className="flex items-center gap-2">
        <ShieldCheck aria-hidden className="size-5" />
        <h1 className="text-base font-semibold tracking-tight">GitHub Triage</h1>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <LiveStatus />
          {/* The effect picker is dev scaffolding (see refresh-fx.tsx); no room for it on narrow screens. */}
          <div className="hidden sm:block">
            <FxPicker />
          </div>
          <RefreshButton />
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
