import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Code,
  GitPullRequest,
  GitPullRequestDraft,
  KeyRound,
  MessageSquare,
  Package,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  isStale,
  prNextStep,
  relativeAge,
  type AlertSource,
  type ChecksState,
  type Issue,
  type PrNextStep,
  type PullRequest,
  type SecurityAlert,
  type Severity,
} from "@/lib/triage";
import { cn } from "@/lib/utils";

export const TONE = {
  danger: "bg-destructive/10 text-destructive",
  orange: "bg-orange/12 text-orange",
  warning: "bg-warning/15 text-warning",
  success: "bg-success/12 text-success",
  info: "bg-info/12 text-info",
  muted: "bg-muted text-muted-foreground",
} as const;
export type Tone = keyof typeof TONE;

export function Pill({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

function Row({ icon, title, url, number, meta, trailing }: {
  icon: ReactNode;
  title: string;
  url: string;
  number?: number;
  meta: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-2.5 px-3 py-2 transition-colors hover:bg-muted/40">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="line-clamp-2 text-sm leading-snug font-medium break-words hover:underline"
        >
          {title}
          {number !== undefined && <span className="ml-1 font-normal text-muted-foreground">#{number}</span>}
        </a>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">{meta}</div>
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-1.5 pt-0.5">{trailing}</div>}
    </li>
  );
}

function RepoLink({ repo }: { repo: string }) {
  return (
    <Link
      href={`/?repo=${encodeURIComponent(repo)}`}
      className="max-w-48 truncate font-mono hover:text-foreground hover:underline"
      title={`Show only ${repo}`}
    >
      {repo}
    </Link>
  );
}

function Age({ iso, verb = "updated", flagStale = true }: { iso: string; verb?: string; flagStale?: boolean }) {
  const stale = flagStale && isStale(iso);
  return (
    <time dateTime={iso} title={`${verb} ${new Date(iso).toLocaleString()}`} className={cn(stale && "text-orange")}>
      {relativeAge(iso)}
      {stale && " · stale"}
    </time>
  );
}

function Labels({ labels }: { labels: { name: string; color: string }[] }) {
  return labels.slice(0, 3).map((l) => (
    <span key={l.name} className="inline-flex items-center gap-1">
      <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: `#${l.color}` }} />
      {l.name}
    </span>
  ));
}

function CommonMeta({ item }: { item: PullRequest | Issue }) {
  return (
    <>
      <RepoLink repo={item.repo} />
      <span>{item.author}</span>
      <Age iso={item.updatedAt} />
      {item.comments > 0 && (
        <span className="inline-flex items-center gap-0.5" aria-label={`${item.comments} comments`}>
          <MessageSquare aria-hidden className="size-3" />
          {item.comments}
        </span>
      )}
      <Labels labels={item.labels} />
    </>
  );
}

const CHECKS: Record<ChecksState, { icon: typeof CircleCheck; className: string; label: string } | null> = {
  passing: { icon: CircleCheck, className: "text-success", label: "Checks passing" },
  failing: { icon: CircleX, className: "text-destructive", label: "Checks failing" },
  pending: { icon: CircleDashed, className: "text-warning", label: "Checks running" },
  none: null,
};

function Checks({ state }: { state: ChecksState }) {
  const c = CHECKS[state];
  if (!c) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={c.label}>
          <c.icon aria-hidden className={cn("size-4", c.className)} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{c.label}</TooltipContent>
    </Tooltip>
  );
}

const NEXT_STEP: Record<PrNextStep, { label: string; tone: Tone }> = {
  "fix-checks": { label: "Fix checks", tone: "danger" },
  "resolve-conflicts": { label: "Conflicts", tone: "orange" },
  "address-review": { label: "Changes requested", tone: "orange" },
  merge: { label: "Ready to merge", tone: "success" },
  wait: { label: "Awaiting review", tone: "muted" },
  draft: { label: "Draft", tone: "muted" },
};

const REVIEW: Record<NonNullable<PullRequest["review"]>, { label: string; tone: Tone }> = {
  APPROVED: { label: "Approved", tone: "success" },
  CHANGES_REQUESTED: { label: "Changes requested", tone: "orange" },
  REVIEW_REQUIRED: { label: "Needs review", tone: "muted" },
};

/**
 * `perspective` picks what matters: as the author you want your next step;
 * as a reviewer/maintainer you want size and the current review state.
 */
export function PrRow({ pr, perspective }: { pr: PullRequest; perspective: "author" | "reviewer" }) {
  const Icon = pr.isDraft ? GitPullRequestDraft : GitPullRequest;
  const step = NEXT_STEP[prNextStep(pr)];
  const review = pr.review && REVIEW[pr.review];
  return (
    <Row
      icon={<Icon aria-label={pr.isDraft ? "Draft pull request" : "Pull request"} className={cn("size-4", pr.isDraft ? "text-muted-foreground" : "text-success")} />}
      title={pr.title}
      url={pr.url}
      number={pr.number}
      meta={
        <>
          <CommonMeta item={pr} />
          <span className="font-mono">
            <span className="text-success">+{pr.additions}</span> <span className="text-destructive">−{pr.deletions}</span>
          </span>
        </>
      }
      trailing={
        <>
          <Checks state={pr.checks} />
          {perspective === "author" ? (
            <Pill tone={step.tone}>{step.label}</Pill>
          ) : pr.isDraft ? (
            <Pill tone="muted">Draft</Pill>
          ) : pr.conflicting ? (
            <Pill tone="orange">Conflicts</Pill>
          ) : (
            review && <Pill tone={review.tone}>{review.label}</Pill>
          )}
        </>
      }
    />
  );
}

export function IssueRow({ issue }: { issue: Issue }) {
  return (
    <Row
      icon={<CircleDot aria-label="Issue" className="size-4 text-success" />}
      title={issue.title}
      url={issue.url}
      number={issue.number}
      meta={<CommonMeta item={issue} />}
    />
  );
}

export const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: "danger",
  high: "orange",
  medium: "warning",
  low: "info",
  unknown: "muted",
};

export const SOURCE: Record<AlertSource, { icon: typeof Package; label: string }> = {
  dependabot: { icon: Package, label: "Dependabot" },
  "code-scanning": { icon: Code, label: "Code scanning" },
  "secret-scanning": { icon: KeyRound, label: "Secret scanning" },
};

export function AlertRow({ alert }: { alert: SecurityAlert }) {
  const source = SOURCE[alert.source];
  return (
    <Row
      icon={<source.icon aria-label={source.label} className="size-4 text-muted-foreground" />}
      title={alert.title}
      url={alert.url}
      meta={
        <>
          <RepoLink repo={alert.repo} />
          <span>{source.label}</span>
          {alert.detail && <span className="max-w-64 truncate font-mono">{alert.detail}</span>}
          <Age iso={alert.createdAt} verb="opened" flagStale={false} />
        </>
      }
      trailing={<Pill tone={SEVERITY_TONE[alert.severity]} className="capitalize">{alert.severity}</Pill>}
    />
  );
}
