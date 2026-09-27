import {
  CircleDot,
  CircleHelp,
  Eye,
  GitPullRequest,
  GitPullRequestArrow,
  Inbox as InboxIcon,
  ShieldAlert,
  TriangleAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import {
  getInbox,
  getRateLimits,
  getSecurity,
  type Failure,
  type Inbox,
  type InboxSection,
  type RateLimits,
  type Result,
  type SecurityReport,
} from "@/lib/github/data";
import {
  countBySeverity,
  filterByRepo,
  prNextStep,
  relativeAge,
  SEVERITIES,
  sortAlerts,
  sortByNextStep,
  type AlertSource,
} from "@/lib/triage";
import { cn } from "@/lib/utils";

import { MoreOnGitHub, Panel, PanelSkeleton } from "./panel";
import { FxNumber } from "./refresh-fx";
import { AlertRow, IssueRow, Pill, PrRow, SEVERITY_TONE, SOURCE, TONE, type Tone } from "./rows";

export async function Dashboard({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { repo: raw } = await searchParams;
  const repo = typeof raw === "string" && /^[\w.-]+\/[\w.-]+$/.test(raw) ? raw : undefined;

  // Start both now so the slow security fan-out runs in parallel with the inbox query.
  const inbox = getInbox();
  const security = getSecurity();
  const limits = getRateLimits();

  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <InboxView inbox={inbox} security={security} limits={limits} repo={repo} />
    </Suspense>
  );
}

type Pending<T> = Promise<Result<T>>;

async function InboxView({
  inbox: pending,
  security,
  limits,
  repo,
}: {
  inbox: Pending<Inbox>;
  security: Pending<SecurityReport>;
  limits: Pending<RateLimits>;
  repo?: string;
}) {
  const result = await pending;
  if (!result.ok) return <ErrorCard error={result.error} />;
  const inbox = result.data;

  const pick = (s: "review" | "mine" | "incoming") => filterByRepo(inbox[s].items, repo);
  const review = pick("review");
  const mine = sortByNextStep(pick("mine"));
  const incoming = pick("incoming");
  const assigned = filterByRepo(inbox.assigned.items, repo);
  const untriaged = filterByRepo(inbox.untriaged.items, repo);

  // With a repo filter we can only count what we fetched; unfiltered, GitHub's totals are exact.
  const total = (s: InboxSection, shown: number) => (repo ? shown : inbox[s].total);
  const actionable = mine.filter((pr) => ["fix-checks", "resolve-conflicts", "address-review"].includes(prNextStep(pr))).length;
  const mergeable = mine.filter((pr) => prNextStep(pr) === "merge").length;
  const searchUrl = (kind: "pulls" | "issues", s: InboxSection) =>
    `https://github.com/${kind}?q=${encodeURIComponent(inbox.queries[s])}`;
  const more = (kind: "pulls" | "issues", s: InboxSection, shown: number) =>
    repo ? null : <MoreOnGitHub shown={shown} total={inbox[s].total} href={searchUrl(kind, s)} />;

  return (
    <div className="space-y-3">
      <ContextLine inbox={inbox} limits={limits} repo={repo} />

      <nav aria-label="Sections" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Stat href="#review" label="Review requested" value={total("review", review.length)} tone={review.length ? "info" : undefined} />
        <Stat
          href="#mine"
          label="Your PRs"
          value={total("mine", mine.length)}
          sub={[actionable && `${actionable} need you`, mergeable && `${mergeable} mergeable`].filter(Boolean).join(" · ")}
          tone={actionable ? "orange" : mergeable ? "success" : undefined}
        />
        <Stat href="#incoming" label="Incoming PRs" value={total("incoming", incoming.length)} />
        <Stat href="#assigned" label="Assigned issues" value={total("assigned", assigned.length)} />
        <Stat href="#untriaged" label="Untriaged issues" value={total("untriaged", untriaged.length)} tone={untriaged.length ? "warning" : undefined} />
        <Suspense fallback={<Stat href="#security" label="Security alerts" value="…" />}>
          <SecurityStat security={security} repo={repo} />
        </Suspense>
      </nav>

      <RepoChips inbox={inbox} active={repo} />

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel id="review" icon={Eye} title="Needs your review" count={review.length} empty="No reviews waiting on you." footer={more("pulls", "review", inbox.review.items.length)}>
          {review.map((pr) => <PrRow key={pr.url} pr={pr} perspective="reviewer" />)}
        </Panel>
        <Panel id="mine" icon={GitPullRequest} title="Your pull requests" count={mine.length} empty="No open pull requests." footer={more("pulls", "mine", inbox.mine.items.length)}>
          {mine.map((pr) => <PrRow key={pr.url} pr={pr} perspective="author" />)}
        </Panel>
        <Panel id="incoming" icon={GitPullRequestArrow} title="Incoming pull requests" count={incoming.length} empty="No one else has PRs open on your repos." footer={more("pulls", "incoming", inbox.incoming.items.length)}>
          {incoming.map((pr) => <PrRow key={pr.url} pr={pr} perspective="reviewer" />)}
        </Panel>
        <Suspense fallback={<PanelSkeleton rows={5} />}>
          <SecurityPanel security={security} repo={repo} />
        </Suspense>
        <Panel id="assigned" icon={CircleDot} title="Assigned to you" count={assigned.length} empty="No issues assigned to you." footer={more("issues", "assigned", inbox.assigned.items.length)}>
          {assigned.map((i) => <IssueRow key={i.url} issue={i} />)}
        </Panel>
        <Panel id="untriaged" icon={InboxIcon} title="Untriaged issues" count={untriaged.length} empty="Every issue on your repos has an owner." footer={more("issues", "untriaged", inbox.untriaged.items.length)}>
          {untriaged.map((i) => <IssueRow key={i.url} issue={i} />)}
        </Panel>
      </div>
    </div>
  );
}

function ContextLine({ inbox, limits, repo }: { inbox: Inbox; limits: Pending<RateLimits>; repo?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        {/* eslint-disable-next-line @next/next/no-img-element -- tiny avatar, no need for the image optimizer */}
        <img src={inbox.viewer.avatarUrl} alt="" width={16} height={16} className="size-4 rounded-full" />
        <span className="font-medium text-foreground">@{inbox.viewer.login}</span>
      </span>
      {repo && (
        <Link href="/" className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground hover:bg-muted/70">
          {repo} <X aria-label="Clear filter" className="size-3" />
        </Link>
      )}
      {/* Last in the row, so nothing moves when it streams in. */}
      <Suspense>
        <ApiBudgets limits={limits} />
      </Suspense>
    </div>
  );
}

async function ApiBudgets({ limits }: { limits: Pending<RateLimits> }) {
  const result = await limits;
  if (!result.ok) return null;
  const { graphql, rest } = result.data;
  return (
    <span className="inline-flex items-center gap-x-2">
      <Budget name="GraphQL" hint="PR & issue panels" {...graphql} />
      <span aria-hidden>·</span>
      <Budget name="REST" hint="security scans, 3 per repo" {...rest} />
    </span>
  );
}

function Budget({ name, hint, remaining, limit, resetAt }: { name: string; hint: string } & RateLimits["rest"]) {
  return (
    <span
      title={`${name} API (${hint}): ${remaining.toLocaleString()} of ${limit.toLocaleString()} left this hour. Resets ${new Date(resetAt).toLocaleTimeString()}.`}
      className={cn("tabular-nums", remaining < limit * 0.1 && "text-destructive")}
    >
      {name} {remaining.toLocaleString()}/{limit.toLocaleString()}
    </span>
  );
}

function Stat({ href, label, value, sub, tone }: { href: string; label: string; value: number | string; sub?: string; tone?: Tone }) {
  return (
    <a href={href} data-fx-panel className="group flex min-w-0 items-baseline gap-2 rounded-xl border bg-card px-3 py-2 transition-colors hover:bg-muted/50">
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

function RepoChips({ inbox, active }: { inbox: Inbox; active?: string }) {
  const counts = new Map<string, number>();
  for (const s of ["review", "mine", "incoming", "assigned", "untriaged"] as const) {
    for (const item of inbox[s].items) counts.set(item.repo, (counts.get(item.repo) ?? 0) + 1);
  }
  const repos = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (repos.length < 2) return null;
  const chip = "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors hover:bg-muted";
  return (
    <nav aria-label="Filter by repository" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
      <Link href="/" aria-current={!active ? "page" : undefined} className={cn(chip, !active && "border-foreground bg-foreground text-background hover:bg-foreground/90")}>
        All
      </Link>
      {repos.map(([repo, n]) => (
        <Link
          key={repo}
          href={`/?repo=${encodeURIComponent(repo)}`}
          aria-current={active === repo ? "page" : undefined}
          className={cn(chip, "font-mono", active === repo && "border-foreground bg-foreground text-background hover:bg-foreground/90")}
        >
          {repo}
          <span className="tabular-nums opacity-60">{n}</span>
        </Link>
      ))}
    </nav>
  );
}

// ---------- Security ----------

async function SecurityStat({ security, repo }: { security: Pending<SecurityReport>; repo?: string }) {
  const result = await security;
  if (!result.ok) return <Stat href="#security" label="Security alerts" value="!" sub="Couldn't load" tone="danger" />;
  const alerts = filterByRepo(result.data.alerts, repo);
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

async function SecurityPanel({ security, repo }: { security: Pending<SecurityReport>; repo?: string }) {
  const result = await security;
  if (!result.ok) {
    return (
      <Panel id="security" icon={ShieldAlert} title="Security alerts">
        <li className="p-3">
          <ErrorCard error={result.error} compact />
        </li>
      </Panel>
    );
  }
  const report = result.data;

  const alerts = sortAlerts(filterByRepo(report.alerts, repo));
  const repos = report.repos.filter((r) => !repo || r.repo === repo);
  const counts = countBySeverity(alerts);
  const sources = Object.keys(SOURCE) as AlertSource[];
  const coverage = sources.map((s) => ({
    source: s,
    on: repos.filter((r) => r.scanners[s].status === "ok").length,
    forbidden: repos.filter((r) => r.scanners[s].status === "forbidden").length,
  }));
  const forbidden = coverage.some((c) => c.forbidden > 0);
  const errored = repos.flatMap((r) => sources.filter((s) => r.scanners[s].status === "error").map((s) => `${r.repo} (${SOURCE[s].label})`));

  return (
    <Panel
      id="security"
      icon={ShieldAlert}
      title="Security alerts"
      count={alerts.length}
      empty={repos.length ? "No open alerts on scanned repos." : "No repositories scanned."}
      aside={SEVERITIES.filter((s) => counts[s] > 0 && s !== "unknown").map((s) => (
        <Pill key={s} tone={SEVERITY_TONE[s]} className="capitalize">
          {counts[s]} {s}
        </Pill>
      ))}
      footer={
        <div className="space-y-1">
          <p>
            {repos.length} {repos.length === 1 ? "repo" : "repos"} scanned {relativeAge(report.scannedAt)} ago ·{" "}
            {coverage.map((c, i) => (
              <span key={c.source}>
                {i > 0 && " · "}
                {SOURCE[c.source].label} {c.on}/{repos.length}
              </span>
            ))}
          </p>
          {forbidden && (
            <p className={cn("flex items-start gap-1 rounded-md px-1.5 py-1", TONE.warning)}>
              <TriangleAlert aria-hidden className="mt-px size-3 shrink-0" />
              <span>
                Some scanners returned 403, so their results are missing from this list. If you use the gh CLI token, run{" "}
                <code className="font-mono">gh auth refresh -s security_events</code>. With a fine-grained token, grant read access to Dependabot alerts, code scanning alerts and secret scanning alerts.
              </span>
            </p>
          )}
          {errored.length > 0 && <p className="text-destructive">Failed: {errored.join(", ")}</p>}
          {report.truncated.length > 0 && <p>Only the first 100 alerts shown for: {report.truncated.join(", ")}</p>}
        </div>
      }
    >
      {alerts.map((a) => <AlertRow key={a.url} alert={a} />)}
    </Panel>
  );
}

// ---------- States ----------

function ErrorCard({ error, compact }: { error: Failure; compact?: boolean }) {
  const noToken = error.kind === "no-token";
  const title = noToken ? "Connect GitHub" : error.status === 401 ? "GitHub rejected the token" : "Couldn't load from GitHub";
  return (
    <div role="alert" className={cn("rounded-xl border bg-card", compact ? "p-3 text-sm" : "mx-auto max-w-xl p-6")}>
      <div className="flex items-center gap-2 font-semibold">
        <CircleHelp aria-hidden className="size-4 text-muted-foreground" />
        {title}
      </div>
      {noToken ? (
        <div className="mt-2 space-y-2 text-sm text-muted-foreground">
          <p>The dashboard reads GitHub with your own token, server-side only. Pick one:</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Run <code className="font-mono text-foreground">gh auth login</code> (add <code className="font-mono text-foreground">-s security_events</code> to include security alerts), or
            </li>
            <li>
              Put a token in <code className="font-mono text-foreground">.env.local</code> as <code className="font-mono text-foreground">GITHUB_TOKEN=…</code> and restart.
            </li>
          </ul>
          <p>Then press Refresh.</p>
        </div>
      ) : (
        <p className="mt-2 font-mono text-xs break-words text-muted-foreground">{error.message}</p>
      )}
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-3" aria-busy aria-label="Loading">
      <Skeleton className="h-4 w-48" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[3.25rem] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {Array.from({ length: 6 }, (_, i) => (
          <PanelSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
