import { CircleHelp, LogOut, ShieldAlert, Star, TriangleAlert, X } from "lucide-react";

import { useActivity, useInbox, useRateLimits, useSecurity, useSession } from "@/client/api";
import { AppLink, useRepoFilter } from "@/client/url";
import { Skeleton } from "@/components/ui/skeleton";
import type { Inbox, RateLimits } from "@/lib/github/inbox";
import type { Failure } from "@/lib/github/result";
import type { SecurityReport } from "@/lib/github/security";
import { ago, type AlertSource } from "@/lib/triage";
import { cn } from "@/lib/utils";

import { LiveInbox, LiveSecurityPanel, LiveSecurityStat, Stat } from "./live-inbox";
import { Panel, PanelSkeleton } from "./panel";
import { ActivityRow, SOURCE, TONE } from "./rows";

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
  if (inbox.isError) return <ErrorCard error={{ kind: "unexpected", message: inbox.error.message }} oauth={oauth} />;
  if (!inbox.data.ok) return <ErrorCard error={inbox.data.error} oauth={oauth} />;
  const data = inbox.data.data;

  // Panels overlay live updates on this snapshot.
  return (
    <LiveInbox
      inbox={data}
      repo={repo}
      live
      contextLine={<ContextLine inbox={data} repo={repo} oauth={oauth} />}
      securityStat={<SecurityStat repo={repo} />}
      securityPanel={<SecurityPanel repo={repo} oauth={oauth} />}
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
        <AppLink href="/" className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground hover:bg-muted/70">
          {repo} <X aria-label="Clear filter" className="size-3" />
        </AppLink>
      )}
      {/* Last in the row, so nothing moves when it loads. */}
      <ApiBudgets />
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

function ApiBudgets() {
  const { data: result } = useRateLimits();
  if (!result?.ok) return null;
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

// ---------- Security ----------

function SecurityStat({ repo }: { repo?: string }) {
  const { data: result, isPending } = useSecurity();
  if (isPending) return <Stat href="#security" label="Security alerts" value="…" />;
  if (result?.ok) return <LiveSecurityStat report={result.data} repo={repo} />;
  return result?.error.kind === "scanning" ? (
    <Stat href="#security" label="Security alerts" value="…" sub="Scanning" />
  ) : (
    <Stat href="#security" label="Security alerts" value="!" sub="Couldn't load" tone="danger" />
  );
}

function SecurityPanel({ repo, oauth }: { repo?: string; oauth: boolean }) {
  const { data: result, isError, error } = useSecurity();
  if (!result && !isError) return <PanelSkeleton rows={5} />;
  if (!result?.ok) {
    const failure: Failure = result ? result.error : { kind: "unexpected", message: error?.message ?? "Request failed" };
    return (
      <Panel id="security" icon={ShieldAlert} title="Security alerts">
        <li className="p-3">
          {failure.kind === "scanning" ? (
            <p className="text-sm text-muted-foreground">{failure.message}</p>
          ) : (
            <ErrorCard error={failure} compact oauth={oauth} />
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
  const errored = repos.flatMap((r) => sources.filter((s) => r.scanners[s].status === "error").map((s) => `${r.repo} (${SOURCE[s].label})`));

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
                <code className="font-mono">gh auth refresh -s security_events</code>. With a fine-grained token, grant read access to Dependabot alerts, code scanning alerts and secret scanning alerts.
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

// ---------- Stars & followers ----------

function ActivityPanel({ repo, oauth }: { repo?: string; oauth: boolean }) {
  const { data: result, isError, error } = useActivity();
  if (!result && !isError) return <PanelSkeleton rows={3} />;
  if (!result?.ok) {
    const failure: Failure = result ? result.error : { kind: "unexpected", message: error?.message ?? "Request failed" };
    return (
      <Panel quiet id="activity" icon={Star} title="Stars & followers">
        <li className="p-3">
          <ErrorCard error={failure} compact oauth={oauth} />
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
            {plural(stars, "star", "stars")} · {plural(watchers, "watcher", "watchers")} across your repos · {plural(followers, "follower", "followers")}
            {firstSeen && " · GitHub keeps no date for watches (or some follows): \"first seen\" is when this dashboard noticed them"}
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

function ErrorCard({ error, compact, oauth }: { error: Failure; compact?: boolean; oauth: boolean }) {
  const noToken = error.kind === "no-token";
  const title = noToken ? "Connect GitHub" : error.status === 401 ? "GitHub rejected the token" : "Couldn't load from GitHub";
  if (noToken && oauth) {
    return (
      <div role="alert" className={cn("rounded-xl border bg-card", compact ? "p-3 text-sm" : "mx-auto max-w-xl p-6")}>
        <div className="flex items-center gap-2 font-semibold">
          <CircleHelp aria-hidden className="size-4 text-muted-foreground" />
          Sign in again
        </div>
        <p className="mt-2 text-sm text-muted-foreground">Your GitHub session ended (tokens expire after six months unused, or were revoked).</p>
        {/* A plain link: /auth/* is handled by the Worker. */}
        <a href="/auth/login" className="mt-3 inline-flex h-8 items-center rounded-md bg-foreground px-3 text-sm font-medium text-background hover:bg-foreground/90">
          Sign in with GitHub
        </a>
      </div>
    );
  }
  return (
    <div role="alert" className={cn("rounded-xl border bg-card", compact ? "p-3 text-sm" : "mx-auto max-w-xl p-6")}>
      <div className="flex items-center gap-2 font-semibold">
        <CircleHelp aria-hidden className="size-4 text-muted-foreground" />
        {title}
      </div>
      {noToken ? (
        <div className="mt-2 space-y-2 text-sm text-muted-foreground">
          <p>
            Local development reads GitHub with your own token, server-side only. Put it in{" "}
            <code className="font-mono text-foreground">.dev.vars</code> as <code className="font-mono text-foreground">GITHUB_TOKEN=…</code> (for
            example <code className="font-mono text-foreground">gh auth token</code>, with <code className="font-mono text-foreground">security_events</code> for
            security alerts) and restart <code className="font-mono text-foreground">pnpm dev</code>.
          </p>
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
