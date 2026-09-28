import { CircleCheck, CircleDot, Eye, GitPullRequest, GitPullRequestArrow, Inbox as InboxIcon, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

import { useSecurity } from "@/client/api";

import type { Inbox } from "@/lib/github/inbox";
import type { SecurityReport } from "@/lib/github/security";
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

      {/* One flow in urgency order (what waits on you, then FYI), poured into two balanced
          columns: fixed lanes left a hole under whichever lane had less in it that day. */}
      <div id="panels" tabIndex={-1} className="scroll-mt-4 gap-3 outline-none lg:columns-2 [&>*]:mb-3 [&>*]:break-inside-avoid">
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
      </div>
    </div>
  );
}

const TEXT: Record<Tone, string> = {
  danger: "text-destructive",
  orange: "text-orange",
  warning: "text-warning",
  success: "text-success",
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
  const sig = [...waiting.map((w) => `${w.key}:${w.count}`), security.state].join("|");

  return (
    <nav aria-label="Waiting on you" data-fx-panel data-fx-sig={sig} className="flex flex-wrap items-center gap-1.5">
      {waiting.length === 0 && security.state === "ok" ? (
        <p className="inline-flex items-center gap-1.5 py-1 text-sm font-medium">
          <CircleCheck aria-hidden className="size-4 text-success" />
          Nothing is waiting on you{repo ? ` in ${repo}` : ""}.
        </p>
      ) : (
        waiting.map((w) => (
          // Grey chrome, like the rest of the board: only the count carries the status colour.
          <a
            key={w.key}
            href={w.href}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border bg-card pr-2.5 pl-1 text-xs transition-colors hover:bg-muted/50 sm:h-8 sm:text-sm"
          >
            <span className={cn("rounded-md px-1.5 font-mono font-semibold tabular-nums", TEXT[w.tone])}>
              <FxNumber value={w.count} />
            </span>
            <span className="font-medium">{w.label[w.count === 1 ? 0 : 1]}</span>
          </a>
        ))
      )}
      {security.state === "pending" && <span className="px-1 text-xs text-muted-foreground">Checking security alerts…</span>}
      {security.state === "scanning" && <span className="px-1 text-xs text-muted-foreground">Security scan running…</span>}
      {security.state === "error" && (
        <a
          href="#security"
          className="inline-flex h-7 items-center rounded-lg border bg-card px-2.5 text-xs font-medium text-destructive sm:h-8 sm:text-sm"
        >
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
