import type { LucideIcon } from "lucide-react";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { FxNumber, FxText } from "@/components/triage/refresh-fx";
import { cn } from "@/lib/utils";

export function Panel({
  id,
  icon: Icon,
  title,
  count,
  aside,
  footer,
  empty,
  quiet,
  className,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  count?: number;
  aside?: ReactNode;
  footer?: ReactNode;
  empty?: string;
  /** For FYI lists (nothing is waiting on you): recessed surface, quieter title. */
  quiet?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const isEmpty = !children || (Array.isArray(children) && children.length === 0);
  return (
    <section
      data-fx-panel
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn(
        "flex min-w-0 scroll-mt-4 flex-col rounded-xl border text-card-foreground",
        quiet ? "bg-transparent" : "bg-card",
        className,
      )}
    >
      {/* The title never truncates: when space runs out, the aside wraps under it instead. */}
      <header className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-3 py-2">
        <span className="flex shrink-0 items-center gap-2">
          <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <h2 id={`${id}-title`} className={cn("text-sm", quiet ? "font-medium text-muted-foreground" : "font-semibold")}>
            <FxText text={title} />
          </h2>
          {count !== undefined && (
            <span className="rounded-md bg-muted px-1.5 font-mono text-xs tabular-nums text-muted-foreground">
              <FxNumber value={count} />
            </span>
          )}
        </span>
        {aside && <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">{aside}</div>}
      </header>
      {isEmpty ? (
        <p className="px-3 py-6 text-center text-sm text-muted-foreground">{empty ?? "Nothing here."}</p>
      ) : (
        <ul className="max-h-[30rem] divide-y overflow-y-auto overscroll-contain">{children}</ul>
      )}
      {footer && <footer className="border-t px-3 py-1.5 text-xs text-muted-foreground">{footer}</footer>}
    </section>
  );
}

export function MoreOnGitHub({ shown, total, href }: { shown: number; total: number; href: string }) {
  if (total <= shown) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
      Showing {shown} of {total} · view all on GitHub <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}

export function PanelSkeleton({ className, rows = 4 }: { className?: string; rows?: number }) {
  return (
    <div className={cn("rounded-xl border bg-card", className)} aria-hidden>
      <div className="flex h-11 items-center gap-2 border-b px-3">
        <Skeleton className="size-4" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="space-y-2 px-3 py-2.5">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  );
}
