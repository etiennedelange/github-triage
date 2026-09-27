import { CircleHelp, LogOut, ShieldAlert, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { oauthEnabled } from "@/lib/github/client";
import {
  getInbox,
  getRateLimits,
  getSecurity,
  type Failure,
  type Inbox,
  type RateLimits,
  type Result,
  type SecurityReport,
} from "@/lib/github/data";
import { relativeAge, type AlertSource } from "@/lib/triage";
import { cn } from "@/lib/utils";

import { LiveInbox, LiveSecurityPanel, LiveSecurityStat, Stat } from "./live-inbox";
import { Panel, PanelSkeleton } from "./panel";
import { SOURCE, TONE } from "./rows";

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

  // Panels render client-side so live updates can overlay the snapshot fetched here.
  return (
    <LiveInbox
      inbox={inbox}
      repo={repo}
      live={oauthEnabled()}
      contextLine={<ContextLine inbox={inbox} limits={limits} repo={repo} />}
      securityStat={
        <Suspense fallback={<Stat href="#security" label="Security alerts" value="…" />}>
          <SecurityStat security={security} repo={repo} />
        </Suspense>
      }
      securityPanel={
        <Suspense fallback={<PanelSkeleton rows={5} />}>
          <SecurityPanel security={security} repo={repo} />
        </Suspense>
      }
    />
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
      {oauthEnabled() && (
        // Handled by the Worker entry, outside Next: POST so a prefetch can't sign you out.
        <form action="/auth/logout" method="post" className="ml-auto">
          <button type="submit" className="inline-flex items-center gap-1 hover:text-foreground">
            <LogOut aria-hidden className="size-3" /> Sign out
          </button>
        </form>
      )}
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

// ---------- Security ----------

async function SecurityStat({ security, repo }: { security: Pending<SecurityReport>; repo?: string }) {
  const result = await security;
  if (!result.ok) {
    return result.error.kind === "scanning" ? (
      <Stat href="#security" label="Security alerts" value="…" sub="Scanning" />
    ) : (
      <Stat href="#security" label="Security alerts" value="!" sub="Couldn't load" tone="danger" />
    );
  }
  return <LiveSecurityStat report={result.data} repo={repo} />;
}

async function SecurityPanel({ security, repo }: { security: Pending<SecurityReport>; repo?: string }) {
  const result = await security;
  if (!result.ok) {
    return (
      <Panel id="security" icon={ShieldAlert} title="Security alerts">
        <li className="p-3">
          {result.error.kind === "scanning" ? (
            <p className="text-sm text-muted-foreground">{result.error.message}</p>
          ) : (
            <ErrorCard error={result.error} compact />
          )}
        </li>
      </Panel>
    );
  }
  const report = result.data;

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
    />
  );
}

// ---------- States ----------

function ErrorCard({ error, compact }: { error: Failure; compact?: boolean }) {
  const noToken = error.kind === "no-token";
  const title = noToken ? "Connect GitHub" : error.status === 401 ? "GitHub rejected the token" : "Couldn't load from GitHub";
  if (noToken && oauthEnabled()) {
    return (
      <div role="alert" className={cn("rounded-xl border bg-card", compact ? "p-3 text-sm" : "mx-auto max-w-xl p-6")}>
        <div className="flex items-center gap-2 font-semibold">
          <CircleHelp aria-hidden className="size-4 text-muted-foreground" />
          Sign in again
        </div>
        <p className="mt-2 text-sm text-muted-foreground">Your GitHub session ended (tokens expire after six months unused, or were revoked).</p>
        {/* A plain link: /auth/* is handled by the Worker, outside Next's router. */}
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
