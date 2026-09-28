import { CircleCheck, CircleDot, Eye, GitPullRequest, GitPullRequestArrow, Inbox as InboxIcon, ShieldAlert } from "lucide-react";
import { Children, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useSecurity } from "@/client/api";

import type { Inbox } from "@/lib/github/inbox";
import type { SecurityReport } from "@/lib/github/security";
import { balancedSplit } from "@/lib/layout";
import { overlayAlerts, overlayItems } from "@/lib/live";
import {
  countBySeverity,
  filterByRepo,
  prNextStep,
  SEVERITIES,
  sortAlerts,
  sortByNextStep,
  type InboxSection,
  type Issue,
  type PullRequest,
} from "@/lib/triage";
import { AppLink } from "@/client/url";
import { cn } from "@/lib/utils";

import { useLive, useLiveConnection } from "./live";
import { MoreOnGitHub, Panel } from "./panel";
import { FxNumber } from "./refresh-fx";
import { AlertRow, IssueRow, Pill, PrRow, SEVERITY_TONE, type Tone } from "./rows";

/**
 * Row key that changes with each live update, and again when you come back to a tab that
 * got the update while hidden, so the row's flash replays where you can see it.
 */
const rowKey = (url: string, live: Map<string, number>, returned: ReadonlyMap<string, number>) =>
  `${url}@${live.get(url) ?? 0}@${returned.get(url) ?? 0}`;

/**
 * The PR & issue panels with live updates overlaid. The server fetched `inbox`; this only
 * applies patches newer than it. The security stat and panel stream in separately (slots).
 */
export function LiveInbox({
  inbox,
  repo,
  live: enabled,
  contextLine,
  securityPanel,
  branchesPanel,
  activityPanel,
}: {
  inbox: Inbox;
  repo?: string;
  live: boolean;
  contextLine: ReactNode;
  securityPanel: ReactNode;
  branchesPanel: ReactNode;
  activityPanel: ReactNode;
}) {
  useLiveConnection(enabled, inbox.fetchedAt);
  const { items: patches, returned } = useLive();
  const at = Date.parse(inbox.fetchedAt);

  const view = <T extends PullRequest | Issue>(s: InboxSection) => {
    const o = overlayItems(s, inbox[s].items as T[], patches, at);
    // With a repo filter we can only count what we fetched; unfiltered, GitHub's totals are exact.
    const items = filterByRepo(o.items, repo);
    return { ...o, all: o.items, items, total: repo ? items.length : inbox[s].total + o.delta, fetched: o.items.length };
  };
  const review = view<PullRequest>("review");
  const mine = view<PullRequest>("mine");
  const incoming = view<PullRequest>("incoming");
  const assigned = view<Issue>("assigned");
  const untriaged = view<Issue>("untriaged");
  const mineSorted = sortByNextStep(mine.items);

  const steps = mine.items.map(prNextStep);
  const searchUrl = (kind: "pulls" | "issues", s: InboxSection) => `https://github.com/${kind}?q=${encodeURIComponent(inbox.queries[s])}`;
  const more = (kind: "pulls" | "issues", s: InboxSection, v: { fetched: number; total: number }) =>
    // null, not an element that renders nothing: the Panel draws its footer strip for any truthy value.
    repo || v.total <= v.fetched ? null : <MoreOnGitHub shown={v.fetched} total={v.total} href={searchUrl(kind, s)} />;
  const where = repo ? ` in ${repo}` : "";

  // What's waiting on you first, in the order you'd act on it; then lists that are just for your information.
  return (
    <div className="space-y-3">
      {contextLine}

      <WaitingOnYou
        repo={repo}
        pr={{
          failing: steps.filter((s) => s === "fix-checks").length,
          conflicts: steps.filter((s) => s === "resolve-conflicts").length,
          changes: steps.filter((s) => s === "address-review").length,
          mergeable: steps.filter((s) => s === "merge").length,
        }}
        reviews={review.items.length}
        assigned={assigned.items.length}
      />

      <RepoChips lists={[review.all, mine.all, incoming.all, assigned.all, untriaged.all]} active={repo} />

      {/* What's waiting on you on the left, FYI on the right, unless that leaves a hole: then the
          split moves along the same order. Each column stacks on its own. */}
      <Stacks split={4}>
        <Panel
          id="review"
          icon={Eye}
          title="Needs your review"
          count={review.items.length}
          empty={`No reviews waiting on you${where}.`}
          footer={more("pulls", "review", review)}
        >
          {review.items.map((pr) => (
            <PrRow
              key={rowKey(pr.url, review.live, returned)}
              live={review.live.has(pr.url) || returned.has(pr.url)}
              pr={pr}
              perspective="reviewer"
            />
          ))}
        </Panel>
        <Panel
          id="mine"
          icon={GitPullRequest}
          title="Your pull requests"
          count={mine.items.length}
          empty={`No open pull requests${where}.`}
          footer={more("pulls", "mine", mine)}
        >
          {mineSorted.map((pr) => (
            <PrRow
              key={rowKey(pr.url, mine.live, returned)}
              live={mine.live.has(pr.url) || returned.has(pr.url)}
              pr={pr}
              perspective="author"
            />
          ))}
        </Panel>
        {securityPanel}
        <Panel
          id="assigned"
          icon={CircleDot}
          title="Assigned to you"
          count={assigned.items.length}
          empty={`No issues assigned to you${where}.`}
          footer={more("issues", "assigned", assigned)}
        >
          {assigned.items.map((i) => (
            <IssueRow key={rowKey(i.url, assigned.live, returned)} live={assigned.live.has(i.url) || returned.has(i.url)} issue={i} />
          ))}
        </Panel>
        <Panel
          quiet
          id="incoming"
          icon={GitPullRequestArrow}
          title="Incoming pull requests"
          count={incoming.items.length}
          empty={repo ? `No one else has PRs open on ${repo}.` : "No one else has PRs open on your repos."}
          footer={more("pulls", "incoming", incoming)}
        >
          {incoming.items.map((pr) => (
            <PrRow
              key={rowKey(pr.url, incoming.live, returned)}
              live={incoming.live.has(pr.url) || returned.has(pr.url)}
              pr={pr}
              perspective="reviewer"
            />
          ))}
        </Panel>
        <Panel
          quiet
          id="untriaged"
          icon={InboxIcon}
          title="Unassigned issues"
          count={untriaged.items.length}
          empty={repo ? `Every issue on ${repo} has an owner.` : "Every issue on your repos has an owner."}
          footer={more("issues", "untriaged", untriaged)}
        >
          {untriaged.items.map((i) => (
            <IssueRow key={rowKey(i.url, untriaged.live, returned)} live={untriaged.live.has(i.url) || returned.has(i.url)} issue={i} />
          ))}
        </Panel>
        {branchesPanel}
        {activityPanel}
      </Stacks>
    </div>
  );
}

/** Tailwind's `lg`, where the panels sit in two columns; `space-y-3` between them. */
const TWO_COLUMNS = "(min-width: 64rem)";
const GAP = 12;

/**
 * Two columns of panels in reading order: the first `split` on the left, the rest on the right.
 * If that leaves one column much taller, the split moves along the order to even them out.
 */
function Stacks({ split: initial, children }: { split: number; children: ReactNode }) {
  const panels = Children.toArray(children);
  const [split, setSplit] = useState(initial);
  const slots = useRef<(HTMLDivElement | null)[]>([]);

  // Moving a panel remounts its slot, so observe again whenever the split changes.
  useLayoutEffect(() => {
    const els = slots.current.slice(0, panels.length);
    const measure = () => {
      if (!matchMedia(TWO_COLUMNS).matches) return;
      const heights = els.map((el) => el?.offsetHeight ?? 0);
      setSplit((k) => balancedSplit(heights, k, GAP));
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const el of els) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [panels.length, split]);

  const slot = (panel: ReactNode, i: number) => (
    <div
      key={(panel as { key?: string }).key ?? i}
      ref={(el) => {
        slots.current[i] = el;
      }}
    >
      {panel}
    </div>
  );
  return (
    <div id="panels" tabIndex={-1} className="grid scroll-mt-4 items-start gap-3 outline-none lg:grid-cols-2">
      <div className="space-y-3">{panels.slice(0, split).map((p, i) => slot(p, i))}</div>
      <div className="space-y-3">{panels.slice(split).map((p, i) => slot(p, split + i))}</div>
    </div>
  );
}

const TEXT: Record<Tone, string> = {
  danger: "text-destructive",
  orange: "text-orange-text",
  warning: "text-warning-text",
  success: "text-success-text",
  info: "text-info",
  muted: "text-muted-foreground",
};

type Waiting = { key: string; href: string; count: number; label: [one: string, many: string]; tone: Tone };

/**
 * The board's headline: everything waiting on you, most urgent first, as links to where it is.
 * It replaces a strip of counts per panel, which repeated the panel headers without ranking them.
 * Empty, it says so: an all-clear you can trust, since the security scan is part of it.
 */
function WaitingOnYou({
  repo,
  pr,
  reviews,
  assigned,
}: {
  repo?: string;
  pr: { failing: number; conflicts: number; changes: number; mergeable: number };
  reviews: number;
  assigned: number;
}) {
  const security = useSecurityCounts(repo);
  const alerts = security.state === "ok" ? security.counts : undefined;
  const all: Waiting[] = [
    { key: "critical", href: "#security", count: alerts?.critical ?? 0, label: ["critical alert", "critical alerts"], tone: "danger" },
    { key: "failing", href: "#mine", count: pr.failing, label: ["PR failing checks", "PRs failing checks"], tone: "danger" },
    { key: "reviews", href: "#review", count: reviews, label: ["review requested", "reviews requested"], tone: "orange" },
    {
      key: "changes",
      href: "#mine",
      count: pr.changes,
      label: ["PR with changes requested", "PRs with changes requested"],
      tone: "orange",
    },
    { key: "conflicts", href: "#mine", count: pr.conflicts, label: ["PR with conflicts", "PRs with conflicts"], tone: "orange" },
    { key: "high", href: "#security", count: alerts?.high ?? 0, label: ["high alert", "high alerts"], tone: "orange" },
    { key: "assigned", href: "#assigned", count: assigned, label: ["issue assigned", "issues assigned"], tone: "muted" },
    { key: "merge", href: "#mine", count: pr.mergeable, label: ["PR ready to merge", "PRs ready to merge"], tone: "success" },
  ];
  const waiting = all.filter((w) => w.count > 0);
  // Ranked in two tiers: what's blocking (red, orange) reads as the headline; the rest steps down.
  const now = waiting.filter((w) => w.tone === "danger" || w.tone === "orange");
  const then = waiting.filter((w) => !now.includes(w));
  const sig = [...waiting.map((w) => `${w.key}:${w.count}`), security.state].join("|");
  const item = (w: Waiting, strong: boolean) => (
    <a
      key={w.key}
      href={w.href}
      className={cn(
        "-my-1 py-1 whitespace-nowrap underline-offset-4 hover:underline",
        strong ? "text-sm font-semibold sm:text-base" : "text-sm font-medium text-muted-foreground hover:text-foreground",
      )}
    >
      <span className={cn("mr-1 font-mono tabular-nums", TEXT[w.tone])}>
        <FxNumber value={w.count} />
      </span>
      {w.label[w.count === 1 ? 0 : 1]}
    </a>
  );

  return (
    <nav aria-label="Waiting on you" data-fx-panel data-fx-sig={sig} className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 py-1">
      {waiting.length === 0 && security.state === "ok" ? (
        <p className="inline-flex items-center gap-1.5 text-base font-semibold">
          <CircleCheck aria-hidden className="size-4 self-center text-success" />
          Nothing is waiting on you{repo ? ` in ${repo}` : ""}.
        </p>
      ) : (
        <>
          {now.map((w) => item(w, true))}
          {now.length > 0 && then.length > 0 && <span aria-hidden className="hidden h-4 w-px self-center bg-border sm:block" />}
          {then.map((w) => item(w, now.length === 0))}
        </>
      )}
      {security.state === "pending" && <span className="text-xs text-muted-foreground">Checking security alerts…</span>}
      {security.state === "scanning" && <span className="text-xs text-muted-foreground">Security scan running…</span>}
      {security.state === "error" && (
        <a href="#security" className="text-sm font-medium text-destructive underline-offset-4 hover:underline">
          Security alerts couldn't load
        </a>
      )}
    </nav>
  );
}

function RepoChips({ lists, active }: { lists: { repo: string }[][]; active?: string }) {
  const counts = new Map<string, number>();
  for (const item of lists.flat()) counts.set(item.repo, (counts.get(item.repo) ?? 0) + 1);
  const repos = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (repos.length < 2) return null;
  // 32px tall on phones, where they're tapped; the fade says the strip scrolls sideways.
  const chip =
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors hover:bg-muted sm:h-6 sm:px-2.5";
  return (
    <nav
      aria-label="Filter by repository"
      className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 mask-r-from-85% sm:mx-0 sm:flex-wrap sm:px-0 sm:mask-none"
    >
      <AppLink
        href="/"
        aria-current={!active ? "page" : undefined}
        className={cn(chip, !active && "border-foreground bg-foreground text-background hover:bg-foreground/90")}
      >
        All
      </AppLink>
      {repos.map(([repo, n]) => (
        <AppLink
          key={repo}
          href={`/?repo=${encodeURIComponent(repo)}`}
          aria-current={active === repo ? "page" : undefined}
          className={cn(chip, "font-mono", active === repo && "border-foreground bg-foreground text-background hover:bg-foreground/90")}
        >
          {repo}
          <span className="tabular-nums opacity-60">{n}</span>
        </AppLink>
      ))}
    </nav>
  );
}

// ---------- Security ----------

function useLiveAlerts(report: SecurityReport, repo?: string) {
  const { alerts: patches, returned } = useLive();
  const o = overlayAlerts(report.alerts, patches, Date.parse(report.scannedAt));
  return { alerts: sortAlerts(filterByRepo(o.items, repo)), live: o.live, returned };
}

/** Live severity counts for the headline; the scan may still be pending or running. */
function useSecurityCounts(repo?: string) {
  const { data: result, isPending } = useSecurity();
  const { alerts: patches } = useLive();
  if (isPending) return { state: "pending" as const };
  if (!result?.ok) return { state: result?.error.kind === "scanning" ? ("scanning" as const) : ("error" as const) };
  const o = overlayAlerts(result.data.alerts, patches, Date.parse(result.data.scannedAt));
  return { state: "ok" as const, counts: countBySeverity(filterByRepo(o.items, repo)) };
}

/** The alert list is live; the coverage footer describes the last full scan, so the server renders it. */
export function LiveSecurityPanel({
  report,
  repo,
  empty,
  footer,
}: {
  report: SecurityReport;
  repo?: string;
  empty: string;
  footer: ReactNode;
}) {
  const { alerts, live, returned } = useLiveAlerts(report, repo);
  const counts = countBySeverity(alerts);
  return (
    <Panel
      id="security"
      icon={ShieldAlert}
      title="Security alerts"
      count={alerts.length}
      empty={empty}
      aside={SEVERITIES.filter((s) => counts[s] > 0 && s !== "unknown").map((s) => (
        <Pill key={s} tone={SEVERITY_TONE[s]} className="capitalize">
          {counts[s]} {s}
        </Pill>
      ))}
      footer={footer}
    >
      {alerts.map((a) => (
        <AlertRow key={rowKey(a.url, live, returned)} alert={a} live={live.has(a.url) || returned.has(a.url)} />
      ))}
    </Panel>
  );
}
