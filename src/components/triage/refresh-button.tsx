import { Binary, Layers, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useLive } from "./live";
import { setEffect, useEffectChoice, useRefreshFx, type Effect } from "./refresh-fx";

/** While live, changes arrive on their own, so Refresh steps back; offline, it's the way to catch up. */
export function RefreshButton() {
  const { pending, run } = useRefreshFx();
  const { status } = useLive();
  return (
    <Button
      variant={status === "live" ? "ghost" : "outline"}
      size="sm"
      disabled={pending}
      onClick={run}
      title="Refetch everything from GitHub (r)"
      className={cn(status === "live" && "text-muted-foreground")}
    >
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

/** Which refresh animation plays. A preference, not a task, so it lives in the status bar. */
export function FxToggle() {
  const fx = useEffectChoice();
  const { icon: Icon, label, next } = META[fx];
  return (
    <button
      type="button"
      onClick={() => setEffect(next)}
      aria-label={`Refresh animation: ${label}. Switch to ${META[next].label}`}
      className="-my-1 inline-flex items-center gap-1 py-1 hover:text-foreground"
    >
      <Icon aria-hidden className="size-3" />
      Refresh animation: {label}
    </button>
  );
}
