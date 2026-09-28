import { CircleHelp, GitBranch, LogOut, RotateCw, ShieldAlert, Star, TriangleAlert, X } from "lucide-react";

import { useActivity, useBranches, useInbox, useRateLimits, useSecurity, useSession } from "@/client/api";
import { AppLink, useRepoFilter } from "@/client/url";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Inbox, RateLimits } from "@/lib/github/inbox";
import type { Failure } from "@/lib/github/result";
import type { SecurityReport } from "@/lib/github/security";
import { ago, filterByRepo, STALE_DAYS, type AlertSource } from "@/lib/triage";
import { cn } from "@/lib/utils";

import { LiveInbox, LiveSecurityPanel } from "./live-inbox";
import { Panel, PanelSkeleton } from "./panel";
import { ActivityRow, BranchRow, SOURCE, TONE } from "./rows";

/**
 * Three independent queries, so the fast inbox shows before the security report and the
 * API budgets, the way the old Suspense boundaries streamed them.
 */
export function Dashboard() {
  const repo = useRepoFilter();
  const inbox = useInbox();
  const session = useSession();
  const oauth = session.data?.oauth ?? false;

  if (inbox.isPending) return <DashboardSkeleton />;
  const retry = () => void inbox.refetch();
  if (inbox.isError) return <ErrorCard error={{ kind: "unexpected", message: inbox.error.message }} oauth={oauth} onRetry={retry} />;
  if (!inbox.data.ok) return <ErrorCard error={inbox.data.error} oauth={oauth} onRetry={retry} />;
  const data = inbox.data.data;

  // Panels overlay live updates on this snapshot.
  return (
    <LiveInbox
      inbox={data}
      repo={repo}
      live
      contextLine={<ContextLine inbox={data} repo={repo} oauth={oauth} />}
      securityPanel={<SecurityPanel repo={repo} oauth={oauth} />}
      branchesPanel={<BranchesPanel repo={repo} oauth={oauth} />}
      activityPanel={<ActivityPanel repo={repo} oauth={oauth} />}
    />
  );
}

function ContextLine({ inbox, repo, oauth }: { inbox: Inbox; repo?: string; oauth: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <img src={inbox.viewer.avatarUrl} alt="" width={16} height={16} className="size-4 rounded-full" />
        <span className="font-medium text-foreground">@{inbox.viewer.login}</span>
      </span>
      {repo && (
        <AppLink
          href="/"
          className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground hover:bg-muted/70"
        >
          {repo} <X aria-label="Clear filter" className="size-3" />
        </AppLink>
      )}
      {/* Only when running low; the status bar always has them (on wider screens). Last in the row, so nothing moves when it loads. */}
      <ApiBudgets onlyLow />
      {oauth && (
        // A plain form post to the Worker: POST so a prefetch can't sign you out.
        <form action="/auth/logout" method="post" className="ml-auto">
          <button type="submit" className="inline-flex items-center gap-1 hover:text-foreground">
            <LogOut aria-hidden className="size-3" /> Sign out
          </button>
        </form>
      )}
    </div>
  );
}

export function ApiBudgets({ onlyLow }: { onlyLow?: boolean }) {
  const { data: result } = useRateLimits();
  if (!result?.ok) return null;
  const { graphql, rest } = result.data;
  if (onlyLow && !isLow(graphql) && !isLow(rest)) return null;
  return (
    <span className="inline-flex items-center gap-x-2">
      <Budget name="GraphQL" hint="PR & issue panels" {...graphql} />
      <span aria-hidden>·</span>
      <Budget name="REST" hint="security scans, 3 per repo" {...rest} />
    </span>
  );
}

const isLow = (b: RateLimits["rest"]) => b.remaining < b.limit * 0.1;

function Budget({ name, hint, remaining, limit, resetAt }: { name: string; hint: string } & RateLimits["rest"]) {
  return (
    <span
      title={`${name} API (${hint}): ${remaining.toLocaleString()} of ${limit.toLocaleString()} left this hour. Resets ${new Date(resetAt).toLocaleTimeString()}.`}
      className={cn("tabular-nums", isLow({ remaining, limit, resetAt }) && "text-destructive")}
    >
      {name} {remaining.toLocaleString()}/{limit.toLocaleString()}
    </span>
  );
}

// ---------- Security ----------

function SecurityPanel({ repo, oauth }: { repo?: string; oauth: boolean }) {
  const { data: result, isError, error, refetch } = useSecurity();
  if (!result && !isError) return <PanelSkeleton rows={5} />;
  if (!result?.ok) {
    const failure: Failure = result ? result.error : { kind: "unexpected", message: error?.message ?? "Request failed" };
    return (
      <Panel id="security" icon={ShieldAlert} title="Security alerts">
        <li className="p-3">
          {failure.kind === "scanning" ? (
            <p className="text-sm text-muted-foreground">{failure.message}</p>
          ) : (
            <ErrorCard error={failure} compact oauth={oauth} onRetry={() => void refetch()} />
          )}
        </li>
      </Panel>
    );
  }
  const report: SecurityReport = result.data;

  const repos = report.repos.filter((r) => !repo || r.repo === repo);
  const sources = Object.keys(SOURCE) as AlertSource[];
  const coverage = sources.map((s) => ({
    source: s,
    on: repos.filter((r) => r.scanners[s].status === "ok").length,
    forbidden: repos.filter((r) => r.scanners[s].status === "forbidden").length,
  }));
  const forbidden = coverage.some((c) => c.forbidden > 0);
  const errored = repos.flatMap((r) =>
    sources.filter((s) => r.scanners[s].status === "error").map((s) => `${r.repo} (${SOURCE[s].label})`),
  );

  return (
    <LiveSecurityPanel
      report={report}
      repo={repo}
      empty={repos.length ? "No open alerts on scanned repos." : "No repositories scanned."}
      footer={
        <div className="space-y-1">
          <p>
            {repos.length} {repos.length === 1 ? "repo" : "repos"} scanned {ago(report.scannedAt)} ·{" "}
            {coverage.map((c, i) => (
              <span key={c.source}>
                {i > 0 && " · "}
                {SOURCE[c.source].label} {c.on}/{repos.length}
              </span>
            ))}
          </p>
          {forbidden && (
            <p role="status" className={cn("flex items-start gap-1 rounded-md px-1.5 py-1", TONE.warning)}>
              <TriangleAlert aria-hidden className="mt-px size-3 shrink-0" />
              <span>
                Some scanners returned 403, so their results are missing from this list. If you use a gh CLI token locally, run{" "}
                <code className="font-mono">gh auth refresh -s security_events</code>. With a fine-grained token, grant read access to
                Dependabot alerts, code scanning alerts and secret scanning alerts.
              </span>
            </p>
          )}
          {errored.length > 0 && (
            <p role="alert" className="text-destructive">
              Failed: {errored.join(", ")}
            </p>
          )}
          {report.truncated.length > 0 && <p>Only the first 100 alerts shown for: {report.truncated.join(", ")}</p>}
        </div>
      }
    />
  );
}

// ---------- Stale branches ----------

function BranchesPanel({ repo, oauth }: { repo?: string; oauth: boolean }) {
  const { data: result, isError, error, refetch } = useBranches();
  if (!result && !isError) return <PanelSkeleton rows={3} />;
  if (!result?.ok) {
    const failure: Failure = result ? result.error : { kind: "unexpected", message: error?.message ?? "Request failed" };
    return (
      <Panel quiet id="branches" icon={GitBranch} title="Stale branches">
        <li className="p-3">
          <ErrorCard error={failure} compact oauth={oauth} onRetry={() => void refetch()} />
        </li>
      </Panel>
    );
  }
  const { branches, repos, truncated, fetchedAt } = result.data;
  const shown = filterByRepo(branches, repo);
  return (
    <Panel
      quiet
      id="branches"
      icon={GitBranch}
      title="Stale branches"
      count={shown.length}
      empty={repo ? "No stale branches on this repo." : "No stale branches on your repos."}
      footer={
        <div className="space-y-1">
          <p>
            Merged or closed PRs whose branch is still there, and branches with no PR and no commits for {STALE_DAYS}+ days · {repos}{" "}
            {repos === 1 ? "repo" : "repos"} checked {ago(fetchedAt)}
          </p>
          {truncated.length > 0 && <p>Only the first 100 branches checked for: {truncated.join(", ")}</p>}
        </div>
      }
    >
      {shown.map((b) => (
        <BranchRow key={`${b.repo}:${b.name}`} branch={b} />
      ))}
    </Panel>
  );
}

// ---------- Stars & followers ----------

function ActivityPanel({ repo, oauth }: { repo?: string; oauth: boolean }) {
  const { data: result, isError, error, refetch } = useActivity();
  if (!result && !isError) return <PanelSkeleton rows={3} />;
  if (!result?.ok) {
    const failure: Failure = result ? result.error : { kind: "unexpected", message: error?.message ?? "Request failed" };
    return (
      <Panel quiet id="activity" icon={Star} title="Stars & followers">
        <li className="p-3">
          <ErrorCard error={failure} compact oauth={oauth} onRetry={() => void refetch()} />
        </li>
      </Panel>
    );
  }
  const { events, stars, followers, watchers, warning, starsSince } = result.data;
  // A repo filter keeps that repo's stars and watchers; follows aren't about any repo.
  const shown = repo ? events.filter((e) => e.kind !== "follow" && e.repo === repo) : events;
  const firstSeen = shown.some((e) => e.kind === "watch" || (e.kind === "follow" && !e.exact));
  const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
  return (
    <Panel
      quiet
      id="activity"
      icon={Star}
      title="Stars & followers"
      count={shown.length}
      empty={repo ? "No stars or new watchers on this repo yet." : "No stars, followers or new watchers yet."}
      footer={
        <div className="space-y-1">
          <p>
            {plural(stars, "star", "stars")} · {plural(watchers, "watcher", "watchers")} across your repos ·{" "}
            {plural(followers, "follower", "followers")}
            {firstSeen && ' · GitHub keeps no date for watches (or some follows): "first seen" is when this dashboard noticed them'}
          </p>
          {starsSince && (
            <p>
              GitHub doesn't let the App list who starred your repos, so stars show as they arrive, since{" "}
              {new Date(starsSince).toLocaleDateString()}.
            </p>
          )}
          {warning && (
            <p role="status" className={cn("flex items-start gap-1 rounded-md px-1.5 py-1 break-words", TONE.warning)}>
              <TriangleAlert aria-hidden className="mt-px size-3 shrink-0" />
              <span>Partly missing: {warning}</span>
            </p>
          )}
        </div>
      }
    >
      {shown.map((e) => (
        <ActivityRow key={`${e.kind}:${e.user.login}:${e.kind === "star" ? e.repo : ""}`} event={e} />
      ))}
    </Panel>
  );
}

// ---------- States ----------

/**
 * Inside a panel (`compact`) it's plain content, not a card within the card. It says what went
 * wrong in words, keeps GitHub's raw message behind Details, and offers a retry.
 */
function ErrorCard({ error, compact, oauth, onRetry }: { error: Failure; compact?: boolean; oauth: boolean; onRetry?: () => void }) {
  const noToken = error.kind === "no-token";
  const box = compact ? "text-sm" : "mx-auto max-w-xl rounded-xl border bg-card p-6";
  if (noToken && oauth) {
    return (
      <div role="alert" className={box}>
        <div className="flex items-center gap-2 font-semibold">
          <CircleHelp aria-hidden className="size-4 text-muted-foreground" />
          Sign in again
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Your GitHub session ended (tokens expire after six months unused, or were revoked).
        </p>
        {/* A plain link: /auth/* is handled by the Worker. */}
        <a
          href="/auth/login"
          className="mt-3 inline-flex h-8 items-center rounded-md bg-foreground px-3 text-sm font-medium text-background hover:bg-foreground/90"
        >
          Sign in with GitHub
        </a>
      </div>
    );
  }
  if (noToken) {
    return (
      <div role="alert" className={box}>
        <div className="flex items-center gap-2 font-semibold">
          <CircleHelp aria-hidden className="size-4 text-muted-foreground" />
          Connect GitHub
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Local development reads GitHub with your own token, server-side only. Put it in{" "}
          <code className="font-mono text-foreground">.dev.vars</code> as <code className="font-mono text-foreground">GITHUB_TOKEN=…</code>{" "}
          (for example <code className="font-mono text-foreground">gh auth token</code>, with{" "}
          <code className="font-mono text-foreground">security_events</code> for security alerts) and restart{" "}
          <code className="font-mono text-foreground">pnpm dev</code>.
        </p>
      </div>
    );
  }
  const rejected = error.status === 401;
  const explain = rejected
    ? "The token was revoked or has expired. Sign in again, or replace GITHUB_TOKEN in local mode."
    : error.kind === "github"
      ? `GitHub returned an error${error.status ? ` (${error.status})` : ""}. It's often temporary.`
      : error.message.startsWith("Unexpected GitHub response")
        ? "GitHub answered in a shape this dashboard doesn't expect."
        : "The request didn't complete. Check your connection, then try again.";
  return (
    <div role="alert" className={box}>
      <div className="flex items-center gap-2 font-semibold">
        <TriangleAlert aria-hidden className="size-4 text-destructive" />
        {rejected ? "GitHub rejected the token" : "Couldn't load from GitHub"}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{explain}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {onRetry && (
          <Button variant="outline" size="xs" onClick={onRetry}>
            <RotateCw data-icon="inline-start" />
            Try again
          </Button>
        )}
        <details className="min-w-0 text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">Details</summary>
          <p className="mt-1 font-mono break-words">{error.message}</p>
        </details>
      </div>
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-3" aria-busy aria-label="Loading">
      <Skeleton className="h-4 w-48" />
      <div className="flex gap-1.5">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-8 w-40 rounded-lg" />
        ))}
      </div>
      <div className="gap-3 lg:columns-2 [&>*]:mb-3 [&>*]:break-inside-avoid">
        {[4, 4, 4, 2, 2, 2, 2, 2].map((rows, i) => (
          <PanelSkeleton key={i} rows={rows} />
        ))}
      </div>
    </div>
  );
}
