import {
  Bot,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Code,
  Eye,
  GitBranch,
  GitPullRequest,
  GitPullRequestDraft,
  KeyRound,
  MessageSquare,
  Package,
  Star,
  UserPlus,
} from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ActivityEvent } from "@/lib/github/activity";
import type { StaleBranch, StaleReason } from "@/lib/github/branches";
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
import { AppLink } from "@/client/url";
import { ClaudeAction, ClaudeStatusPill } from "./claude";
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

/** `live`: arrived or changed via a live update; the row flashes once (see [data-live] in globals.css). */
type LiveProp = { live?: boolean };

function Row({
  icon,
  title,
  url,
  number,
  meta,
  trailing,
  live,
}: LiveProp & {
  icon: ReactNode;
  title: string;
  url: string;
  number?: number;
  meta: ReactNode;
  trailing?: ReactNode;
}) {
  // Desktop: title over meta, with the pills on the right. Phones: the title gets the full width and the
  // pills share the meta line, which stays one line and fades out rather than wrapping to three or four.
  return (
    <li
      data-live={live || undefined}
      className="group/row grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2.5 px-3 py-2 transition-colors hover:bg-muted/40"
    >
      <span className="row-span-2 mt-0.5">{icon}</span>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        data-row-link
        // -my-1/py-1 grow the hit target to 24px tall on single-line titles without pushing the row's layout.
        className="col-span-2 -my-1 line-clamp-2 py-1 text-sm focus-visible:outline-offset-0 leading-snug font-medium break-words hover:underline sm:col-span-1"
      >
        {title}
        {number !== undefined && <span className="ml-1 font-normal text-muted-foreground">#{number}</span>}
      </a>
      <div
        // Phones: py-1.5 keeps the links' 24px hit targets inside the clip; the negative margins cancel it.
        className="col-start-2 row-start-2 -mt-1 -mb-1.5 flex items-center gap-x-2 gap-y-0.5 overflow-hidden py-1.5 text-xs whitespace-nowrap text-muted-foreground mask-r-from-85% sm:my-0 sm:mt-0.5 sm:flex-wrap sm:overflow-visible sm:py-0 sm:whitespace-normal sm:mask-none"
      >
        {meta}
      </div>
      {trailing && (
        <div className="col-start-3 row-start-2 flex items-center gap-1.5 self-center pl-1 sm:row-span-2 sm:row-start-1 sm:self-start sm:pt-0.5 sm:pl-0">
          {trailing}
        </div>
      )}
    </li>
  );
}

function RepoLink({ repo }: { repo: string }) {
  return (
    <AppLink
      href={`/?repo=${encodeURIComponent(repo)}`}
      // -my-1.5/py-1.5 grow the hit target to 24px tall without pushing the row's layout.
      className="-my-1.5 max-w-48 shrink-0 truncate py-1.5 font-mono hover:text-foreground hover:underline"
      title={`Show only ${repo}`}
    >
      {repo}
    </AppLink>
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
      {item.comments > 0 && <Comments item={item} />}
      <Labels labels={item.labels} />
    </>
  );
}

/** The comment count, and who commented last: a bot's deploy preview or your @claude shows up here. */
function Comments({ item }: { item: PullRequest | Issue }) {
  const last = item.latestComment;
  const count = (
    <>
      <MessageSquare aria-hidden className="size-3" />
      {item.comments}
    </>
  );
  if (!last) {
    return (
      <span className="inline-flex items-center gap-0.5" aria-label={`${item.comments} comments`}>
        {count}
      </span>
    );
  }
  const name = last.author.replace(/\[bot\]$/, "");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={last.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`${item.comments} comments, latest by ${last.author} ${relativeAge(last.at)} ago`}
          className="-my-1.5 inline-flex min-w-0 items-center gap-1 py-1.5 hover:text-foreground hover:underline"
        >
          <span className="inline-flex items-center gap-0.5">{count}</span>
          {last.bot && <Bot aria-hidden className="size-3 shrink-0" />}
          <span className="max-w-36 truncate">{name}</span>
        </a>
      </TooltipTrigger>
      <TooltipContent className="max-w-80">
        <span className="font-medium">{last.author}</span>, {relativeAge(last.at)} ago
        {last.excerpt && <span className="mt-0.5 block opacity-80">{last.excerpt}</span>}
      </TooltipContent>
    </Tooltip>
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
export function PrRow({ pr, perspective, live }: LiveProp & { pr: PullRequest; perspective: "author" | "reviewer" }) {
  const Icon = pr.isDraft ? GitPullRequestDraft : GitPullRequest;
  const step = NEXT_STEP[prNextStep(pr)];
  const review = pr.review && REVIEW[pr.review];
  return (
    <Row
      icon={
        <Icon
          aria-label={pr.isDraft ? "Draft pull request" : "Pull request"}
          className={cn("size-4", pr.isDraft ? "text-muted-foreground" : "text-success")}
        />
      }
      title={pr.title}
      url={pr.url}
      number={pr.number}
      live={live}
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
          {pr.claude && <ClaudeStatusPill status={pr.claude} />}
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

export function IssueRow({ issue, live }: LiveProp & { issue: Issue }) {
  return (
    <Row
      icon={<CircleDot aria-label="Issue" className="size-4 text-success" />}
      title={issue.title}
      url={issue.url}
      number={issue.number}
      live={live}
      meta={<CommonMeta item={issue} />}
      trailing={<ClaudeAction issue={issue} />}
    />
  );
}

export const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: "danger",
  high: "orange",
  medium: "warning",
  low: "muted",
  unknown: "muted",
};

export const SOURCE: Record<AlertSource, { icon: typeof Package; label: string }> = {
  dependabot: { icon: Package, label: "Dependabot" },
  "code-scanning": { icon: Code, label: "Code scanning" },
  "secret-scanning": { icon: KeyRound, label: "Secret scanning" },
};

export function AlertRow({ alert, live }: LiveProp & { alert: SecurityAlert }) {
  const source = SOURCE[alert.source];
  return (
    <Row
      icon={<source.icon aria-label={source.label} className="size-4 text-muted-foreground" />}
      title={alert.title}
      url={alert.url}
      live={live}
      meta={
        <>
          <RepoLink repo={alert.repo} />
          <span>{source.label}</span>
          {alert.detail && <span className="max-w-64 truncate font-mono">{alert.detail}</span>}
          <Age iso={alert.createdAt} verb="opened" flagStale={false} />
        </>
      }
      trailing={
        <Pill tone={SEVERITY_TONE[alert.severity]} className="capitalize">
          {alert.severity}
        </Pill>
      }
    />
  );
}

const BRANCH_REASON: Record<StaleReason, { label: string; tone: Tone; hint: string }> = {
  merged: { label: "Merged", tone: "success", hint: "Its pull request was merged: safe to delete" },
  closed: { label: "PR closed", tone: "muted", hint: "Its pull request was closed without merging" },
  idle: { label: "No PR", tone: "warning", hint: "Never had a pull request, and nothing pushed for a while" },
};

/** A branch left behind on one of your repos. Links to the branch; the pill says why it's listed. */
export function BranchRow({ branch }: { branch: StaleBranch }) {
  const reason = BRANCH_REASON[branch.reason];
  return (
    <Row
      icon={<GitBranch aria-hidden className="size-4 text-muted-foreground" />}
      title={branch.name}
      url={branch.url}
      meta={
        <>
          <RepoLink repo={branch.repo} />
          <span>{branch.author}</span>
          <Age iso={branch.committedAt} verb="last commit" flagStale={false} />
          {branch.pr && (
            <a href={branch.pr.url} target="_blank" rel="noreferrer" className="-my-1.5 py-1.5 hover:text-foreground hover:underline">
              #{branch.pr.number}
            </a>
          )}
        </>
      }
      trailing={
        <Pill tone={reason.tone}>
          <span title={reason.hint}>{reason.label}</span>
        </Pill>
      }
    />
  );
}

/** A star or new watcher on one of your repos, or a new follower. Links to the person. */
export function ActivityRow({ event }: { event: ActivityEvent }) {
  const { icon: Icon, verb, className } = ACTIVITY[event.kind];
  const firstSeen = event.kind === "watch" || (event.kind === "follow" && !event.exact);
  return (
    <Row
      icon={<img src={event.user.avatarUrl} alt="" width={16} height={16} className="size-4 rounded-full" />}
      title={`${event.user.login} ${verb}`}
      url={event.user.url}
      meta={
        <>
          <Icon aria-hidden className={cn("size-3", className)} />
          {event.kind !== "follow" && <RepoLink repo={event.repo} />}
          <Age iso={event.at} verb={firstSeen ? "first seen" : verb} flagStale={false} />
          {firstSeen && <span>(first seen)</span>}
        </>
      }
    />
  );
}

const ACTIVITY: Record<ActivityEvent["kind"], { icon: typeof Star; verb: string; className?: string }> = {
  star: { icon: Star, verb: "starred", className: "text-warning" },
  follow: { icon: UserPlus, verb: "followed you" },
  watch: { icon: Eye, verb: "is watching" },
};
