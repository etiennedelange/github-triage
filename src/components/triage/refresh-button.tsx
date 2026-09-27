"use client";

import { Binary, Layers, Radar, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import { EFFECTS, setEffect, useEffectChoice, useRefreshFx, type Effect } from "./refresh-fx";

export function RefreshButton() {
  const { pending, run } = useRefreshFx();
  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={(e) => run(e.currentTarget)}>
      <RefreshCw className={cn(pending && "animate-spin motion-reduce:animate-none")} />
      {/* Both labels share one grid cell so the button never changes width (no layout shift). */}
      <span className="grid">
        <span aria-hidden className="invisible col-start-1 row-start-1">Refreshing</span>
        <span className="col-start-1 row-start-1">{pending ? "Refreshing" : "Refresh"}</span>
      </span>
    </Button>
  );
}

const META: Record<Effect, { icon: typeof Radar; label: string }> = {
  radar: { icon: Radar, label: "Radar" },
  cascade: { icon: Layers, label: "Cascade" },
  decrypt: { icon: Binary, label: "Decrypt" },
};

/** Temporary: pick which refresh effect to try. Remove once one is chosen. */
export function FxPicker() {
  const fx = useEffectChoice();
  return (
    <ToggleGroup
      type="single"
      size="sm"
      variant="outline"
      value={fx}
      onValueChange={(v) => v && setEffect(v as Effect)}
      aria-label="Refresh animation"
    >
      {EFFECTS.map((e) => {
        const { icon: Icon, label } = META[e];
        return (
          <ToggleGroupItem key={e} value={e} aria-label={label} title={label} className="gap-1.5 px-2">
            <Icon />
            <span className="hidden sm:inline">{label}</span>
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
