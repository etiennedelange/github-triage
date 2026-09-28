import { CircleDot, Eye, GitPullRequest, GitPullRequestArrow, Inbox as InboxIcon, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

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
import { AlertRow, IssueRow, Pill, PrRow, SEVERITY_TONE, TONE, type Tone } from "./rows";

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
  securityStat,
  securityPanel,
  activityPanel,
}: {
  inbox: Inbox;
  repo?: string;
  live: boolean;
  contextLine: ReactNode;
  securityStat: ReactNode;
  securityPanel: ReactNode;
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

  const actionable = mine.items.filter((pr) => ["fix-checks", "resolve-conflicts", "address-review"].includes(prNextStep(pr))).length;
  const mergeable = mine.items.filter((pr) => prNextStep(pr) === "merge").length;
  const searchUrl = (kind: "pulls" | "issues", s: InboxSection) =>
    `https://github.com/${kind}?q=${encodeURIComponent(inbox.queries[s])}`;
  const more = (kind: "pulls" | "issues", s: InboxSection, v: { fetched: number; total: number }) =>
    // null, not an element that renders nothing: the Panel draws its footer strip for any truthy value.
    repo || v.total <= v.fetched ? null : <MoreOnGitHub shown={v.fetched} total={v.total} href={searchUrl(kind, s)} />;

  // Ordered by what's waiting on you: your queue first, then the lists that are just for your information.
  return (
    <div className="space-y-3">
      {contextLine}

      <nav aria-label="Sections" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Stat href="#review" label="Needs your review" value={review.total} tone={review.items.length ? "info" : undefined} />
        <Stat
          href="#mine"
          label="Your pull requests"
          value={mine.total}
          sub={[actionable && `${actionable} need you`, mergeable && `${mergeable} mergeable`].filter(Boolean).join(" · ")}
          tone={actionable ? "orange" : mergeable ? "success" : undefined}
        />
        {securityStat}
        <Stat href="#assigned" label="Assigned to you" value={assigned.total} />
        <Stat href="#incoming" label="Incoming pull requests" value={incoming.total} />
        <Stat href="#untriaged" label="Untriaged issues" value={untriaged.total} tone={untriaged.items.length ? "warning" : undefined} />
      </nav>

      <RepoChips lists={[review.all, mine.all, incoming.all, assigned.all, untriaged.all]} active={repo} />

      {/* items-start: a short panel stays short instead of stretching to its neighbour's height. */}
      <div id="panels" tabIndex={-1} className="grid scroll-mt-4 items-start gap-3 outline-none lg:grid-cols-2">
        <Panel id="review" icon={Eye} title="Needs your review" count={review.items.length} empty="No reviews waiting on you." footer={more("pulls", "review", review)}>
          {review.items.map((pr) => <PrRow key={rowKey(pr.url, review.live, returned)} live={review.live.has(pr.url) || returned.has(pr.url)} pr={pr} perspective="reviewer" />)}
        </Panel>
        <Panel id="mine" icon={GitPullRequest} title="Your pull requests" count={mine.items.length} empty="No open pull requests." footer={more("pulls", "mine", mine)}>
          {mineSorted.map((pr) => <PrRow key={rowKey(pr.url, mine.live, returned)} live={mine.live.has(pr.url) || returned.has(pr.url)} pr={pr} perspective="author" />)}
        </Panel>
        {securityPanel}
        <Panel id="assigned" icon={CircleDot} title="Assigned to you" count={assigned.items.length} empty="No issues assigned to you." footer={more("issues", "assigned", assigned)}>
          {assigned.items.map((i) => <IssueRow key={rowKey(i.url, assigned.live, returned)} live={assigned.live.has(i.url) || returned.has(i.url)} issue={i} />)}
        </Panel>
        <Panel quiet id="incoming" icon={GitPullRequestArrow} title="Incoming pull requests" count={incoming.items.length} empty="No one else has PRs open on your repos." footer={more("pulls", "incoming", incoming)}>
          {incoming.items.map((pr) => <PrRow key={rowKey(pr.url, incoming.live, returned)} live={incoming.live.has(pr.url) || returned.has(pr.url)} pr={pr} perspective="reviewer" />)}
        </Panel>
        <Panel quiet id="untriaged" icon={InboxIcon} title="Untriaged issues" count={untriaged.items.length} empty="Every issue on your repos has an owner." footer={more("issues", "untriaged", untriaged)}>
          {untriaged.items.map((i) => <IssueRow key={rowKey(i.url, untriaged.live, returned)} live={untriaged.live.has(i.url) || returned.has(i.url)} issue={i} />)}
        </Panel>
        {activityPanel}
      </div>
    </div>
  );
}

export function Stat({ href, label, value, sub, tone }: { href: string; label: string; value: number | string; sub?: string; tone?: Tone }) {
  return (
    <a href={href} data-fx-panel data-fx-sig={`${value}|${sub ?? ""}`} className="group flex min-w-0 items-baseline gap-2 rounded-xl border bg-card px-3 py-2 transition-colors hover:bg-muted/50">
      <span className={cn("rounded-md px-1.5 font-mono text-lg font-semibold tabular-nums", tone ? TONE[tone] : "text-foreground")}>
        <FxNumber value={value} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium">{label}</span>
        {sub && <span className="block truncate text-[11px] text-muted-foreground">{sub}</span>}
      </span>
    </a>
  );
}

function RepoChips({ lists, active }: { lists: { repo: string }[][]; active?: string }) {
  const counts = new Map<string, number>();
  for (const item of lists.flat()) counts.set(item.repo, (counts.get(item.repo) ?? 0) + 1);
  const repos = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (repos.length < 2) return null;
  const chip = "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-muted";
  return (
    <nav aria-label="Filter by repository" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
      <AppLink href="/" aria-current={!active ? "page" : undefined} className={cn(chip, !active && "border-foreground bg-foreground text-background hover:bg-foreground/90")}>
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

export function LiveSecurityStat({ report, repo }: { report: SecurityReport; repo?: string }) {
  const { alerts } = useLiveAlerts(report, repo);
  const c = countBySeverity(alerts);
  const tone: Tone | undefined = c.critical ? "danger" : c.high ? "orange" : alerts.length ? "warning" : undefined;
  return (
    <Stat
      href="#security"
      label="Security alerts"
      value={alerts.length}
      sub={[c.critical && `${c.critical} critical`, c.high && `${c.high} high`].filter(Boolean).join(" · ")}
      tone={tone}
    />
  );
}

/** The alert list is live; the coverage footer describes the last full scan, so the server renders it. */
export function LiveSecurityPanel({ report, repo, empty, footer }: { report: SecurityReport; repo?: string; empty: string; footer: ReactNode }) {
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
