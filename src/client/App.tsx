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
        <div className="ml-auto flex items-center gap-2">
          <LiveStatus />
          <FxPicker />
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
