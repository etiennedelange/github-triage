// Dependabot, code scanning & secret scanning: runtime-agnostic (no `server-only`, no env
// reads) so both the Next server (local/dev, un-authenticated token) and the Hub Durable
// Object (deployed, chunked background scan) can share the same per-repo scan logic.

import { z } from "zod";

import {
  codeScanningAlert,
  dependabotAlert,
  secretScanningAlert,
  type AlertSource,
  type ScannerStatus,
  type SecurityAlert,
} from "@/lib/triage";

import { GitHubError, rest, type GitHubAuth } from "./http";

export const ALERT_PAGE = 100;

export const SCANNERS = {
  dependabot: { path: "dependabot/alerts", schema: dependabotAlert },
  "code-scanning": { path: "code-scanning/alerts", schema: codeScanningAlert },
  "secret-scanning": { path: "secret-scanning/alerts", schema: secretScanningAlert },
} satisfies Record<AlertSource, { path: string; schema: z.ZodType }>;

export type ScanResult = { status: ScannerStatus; message?: string; alerts: SecurityAlert[]; truncated: boolean };

/**
 * Defined here (not in `data.ts`, which pulls in `next/cache` and `server-only`) so the Hub
 * Durable Object — a plain Workers class, not a Next.js request — can share the same shape.
 */
export type SecurityReport = {
  alerts: SecurityAlert[];
  repos: { repo: string; scanners: Record<AlertSource, { status: ScannerStatus; message?: string }> }[];
  truncated: string[];
  scannedAt: string;
};

/** One repo, one scanner: 1 REST call. Callers fan this out and bound how many run per invocation. */
export async function scanOne(auth: GitHubAuth, repo: string, source: AlertSource): Promise<ScanResult> {
  const { path, schema } = SCANNERS[source];
  try {
    const raw = await rest<unknown[]>(auth, `/repos/${repo}/${path}?state=open&per_page=${ALERT_PAGE}`);
    const alerts = z
      .array(schema)
      .parse(raw)
      .map((a) => ({ ...a, repo }) as SecurityAlert);
    return { status: "ok", alerts, truncated: raw.length === ALERT_PAGE };
  } catch (err) {
    if (!(err instanceof GitHubError)) throw err;
    // 404 = feature off / no analysis yet; 403 = feature off, or the token lacks the scope.
    const status: ScannerStatus =
      err.status === 404 || /disabled|not enabled|no analysis/i.test(err.message)
        ? "disabled"
        : err.status === 403
          ? "forbidden"
          : "error";
    return { status, message: err.message, alerts: [], truncated: false };
  }
}

const repoList = z.array(
  z.object({ full_name: z.string(), archived: z.boolean(), fork: z.boolean(), pushed_at: z.string().nullish() }),
);
const installationList = z.object({ installations: z.array(z.object({ id: z.number() })) });
const installationRepos = z.object({ total_count: z.number(), repositories: repoList });

/**
 * OAuth mode: the repos the GitHub App is installed on, which are exactly the ones the
 * user token can read and webhooks cover. Most recently pushed first, capped at `max`.
 */
export async function listInstalledRepos(auth: GitHubAuth, max: number): Promise<string[]> {
  const { installations } = installationList.parse(await rest(auth, "/user/installations?per_page=100"));
  const repos: { full_name: string; pushed_at?: string | null }[] = [];
  for (const { id } of installations) {
    for (let page = 1; page <= 10; page++) {
      const batch = installationRepos.parse(await rest(auth, `/user/installations/${id}/repositories?per_page=100&page=${page}`));
      repos.push(...batch.repositories.filter((r) => !r.archived && !r.fork));
      if (batch.repositories.length < 100) break;
    }
  }
  return repos
    .toSorted((a, b) => (b.pushed_at ?? "").localeCompare(a.pushed_at ?? ""))
    .slice(0, max)
    .map((r) => r.full_name);
}
