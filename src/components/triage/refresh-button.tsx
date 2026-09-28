import { Binary, Layers, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { setEffect, useEffectChoice, useRefreshFx, type Effect } from "./refresh-fx";

export function RefreshButton() {
  const { pending, run } = useRefreshFx();
  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={run}>
      <RefreshCw data-icon="inline-start" className={cn(pending && "animate-spin motion-reduce:animate-none")} />
      {/* Both labels share one grid cell so the button never changes width (no layout shift). */}
      <span className="grid">
        <span aria-hidden className="invisible col-start-1 row-start-1">
          Refreshing
        </span>
        <span className="col-start-1 row-start-1">{pending ? "Refreshing" : "Refresh"}</span>
      </span>
    </Button>
  );
}

const META: Record<Effect, { icon: typeof Layers; label: string; next: Effect }> = {
  cascade: { icon: Layers, label: "Cascade", next: "decrypt" },
  decrypt: { icon: Binary, label: "Decrypt", next: "cascade" },
};

/** Which refresh animation plays: one quiet icon that flips between the two. */
export function FxToggle() {
  const fx = useEffectChoice();
  const { icon: Icon, label, next } = META[fx];
  const hint = `Animation: ${label}. Switch to ${META[next].label}`;
  return (
    // A preference, not a task: phones need the room for the status and Refresh.
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={hint}
      title={hint}
      onClick={() => setEffect(next)}
      className="hidden text-muted-foreground sm:inline-flex"
    >
      <Icon />
    </Button>
  );
}
