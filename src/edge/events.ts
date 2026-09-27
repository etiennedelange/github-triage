// Reduce a GitHub webhook to the smallest thing that changed. Pure; no I/O.

import { z } from "zod";

import {
  codeScanningAlert,
  dependabotAlert,
  secretScanningAlert,
  type AlertSource,
  type SecurityAlert,
} from "@/lib/triage";

/** A PR or issue to refetch, as "owner/name#number". */
export type SubjectKey = `${string}#${number}`;
export const subjectKey = (repo: string, number: number): SubjectKey => `${repo}#${number}`;

export type Change =
  | { kind: "subject"; key: SubjectKey }
  /** The default branch moved: every open PR's mergeability may have changed. */
  | { kind: "repo-prs"; repo: string }
  | { kind: "alert"; alert: SecurityAlert }
  | { kind: "alert-gone"; url: string }
  /** The payload's alert didn't match our schema: fetch that one alert over REST instead. */
  | { kind: "alert-refetch"; repo: string; source: AlertSource; number: number }
  /** The installation's repo set changed: only a full refetch can tell what's visible now. */
  | { kind: "resync" };

const repoOf = (p: Payload) => p.repository?.full_name;

const payload = z.looseObject({
  action: z.string().optional(),
  ref: z.string().optional(),
  repository: z.looseObject({ full_name: z.string(), default_branch: z.string().optional() }).optional(),
  pull_request: z.looseObject({ number: z.number() }).optional(),
  issue: z.looseObject({ number: z.number() }).optional(),
  check_suite: z.looseObject({ pull_requests: z.array(z.looseObject({ number: z.number() })) }).optional(),
  alert: z.looseObject({ number: z.number(), html_url: z.string() }).optional(),
});
type Payload = z.infer<typeof payload>;

const ALERTS = {
  dependabot_alert: {
    source: "dependabot",
    schema: dependabotAlert,
    open: ["created", "reopened", "reintroduced", "auto_reopened"],
    closed: ["fixed", "dismissed", "auto_dismissed"],
  },
  code_scanning_alert: {
    source: "code-scanning",
    schema: codeScanningAlert,
    open: ["created", "reopened", "reopened_by_user", "appeared_in_branch"],
    closed: ["fixed", "closed_by_user"],
  },
  secret_scanning_alert: {
    source: "secret-scanning",
    schema: secretScanningAlert,
    open: ["created", "reopened", "publicly_leaked", "validated"],
    closed: ["resolved"],
  },
} as const satisfies Record<string, { source: AlertSource; schema: z.ZodType; open: string[]; closed: string[] }>;

export function changesFor(event: string, raw: unknown): Change[] {
  const parsed = payload.safeParse(raw);
  if (!parsed.success) return [];
  const p = parsed.data;
  const repo = repoOf(p);

  switch (event) {
    case "pull_request":
    case "pull_request_review":
      return repo && p.pull_request ? [{ kind: "subject", key: subjectKey(repo, p.pull_request.number) }] : [];

    // issue_comment fires for PR conversation comments too; the number is shared.
    case "issues":
    case "issue_comment":
      return repo && p.issue ? [{ kind: "subject", key: subjectKey(repo, p.issue.number) }] : [];

    // Only same-repo PRs are listed here; fork PRs pick up their checks on the next resync.
    case "check_suite":
      if (p.action !== "completed" || !repo || !p.check_suite) return [];
      return p.check_suite.pull_requests.map((pr) => ({ kind: "subject", key: subjectKey(repo, pr.number) }) as const);

    case "push":
      return repo && p.repository?.default_branch && p.ref === `refs/heads/${p.repository.default_branch}`
        ? [{ kind: "repo-prs", repo }]
        : [];

    case "installation":
    case "installation_repositories":
      return [{ kind: "resync" }];

    case "dependabot_alert":
    case "code_scanning_alert":
    case "secret_scanning_alert": {
      const spec = ALERTS[event];
      if (!repo || !p.alert || !p.action) return [];
      if ((spec.closed as readonly string[]).includes(p.action)) return [{ kind: "alert-gone", url: p.alert.html_url }];
      if (!(spec.open as readonly string[]).includes(p.action)) return [];
      const alert = spec.schema.safeParse(p.alert);
      return alert.success
        ? [{ kind: "alert", alert: { ...alert.data, repo } as SecurityAlert }]
        : [{ kind: "alert-refetch", repo, source: spec.source, number: p.alert.number }];
    }

    default:
      return [];
  }
}
