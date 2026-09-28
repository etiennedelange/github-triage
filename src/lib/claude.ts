// "Fix with Claude": an @claude comment on an issue, answered by the Claude GitHub Action
// (anthropics/claude-code-action) if the repo has its workflow. Pure; shared by the Hub and
// the browser.

/** How far a run has got, in order. A run only moves forward. */
export const CLAUDE_STATES = ["requested", "working", "branch", "pr"] as const;
export type ClaudeState = (typeof CLAUDE_STATES)[number];

export type ClaudeRun = {
  repo: string;
  number: number;
  state: ClaudeState;
  requestedAt: string;
  updatedAt: string;
  /** Our @claude comment. */
  commentUrl: string;
  /** The Action's branch, once pushed. */
  branch?: string;
  prUrl?: string;
  /** Last time the Hub asked GitHub directly, for runs webhooks can't advance (local mode, missed deliveries). */
  checkedAt?: string;
};

/** Runs by "owner/name#number", as the Hub stores them and `/api/claude` returns them. */
export type ClaudeRuns = Record<string, ClaudeRun>;

export type ClaudeSignal =
  /** The Action's tracking comment appeared: it picked up the request. */
  | { kind: "working"; repo: string; number: number }
  | { kind: "branch"; repo: string; number: number; branch: string }
  | { kind: "pr"; repo: string; number: number; url: string };

export const claudeKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

/** The login the Action comments as when it runs as the Claude GitHub App. */
export const CLAUDE_BOT = "claude[bot]";

/** The Action names issue branches `claude/issue-<n>-<timestamp>` (its default `branch_prefix`). */
export function claudeBranchIssue(branch: string): number | undefined {
  const m = /^claude\/issue-(\d+)-/.exec(branch);
  return m ? Number(m[1]) : undefined;
}

/**
 * When the Action created the branch, from its `YYYYMMDD-HHMM` suffix: the runner's clock, which
 * is UTC on GitHub-hosted runners. Epoch ms, or undefined for a name that doesn't follow it.
 */
export function claudeBranchTime(branch: string): number | undefined {
  const m = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(branch);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : undefined;
}

/**
 * The newest of an issue's Claude branches that the Action made for this run, not an earlier
 * one: created no earlier than the minute the run was requested.
 */
export function branchForRun(run: ClaudeRun, branches: string[]): string | undefined {
  const since = Math.floor(Date.parse(run.requestedAt) / 60_000) * 60_000;
  return branches
    .filter((b) => claudeBranchIssue(b) === run.number && (claudeBranchTime(b) ?? -Infinity) >= since)
    .toSorted()
    .at(-1);
}

/** Runs still worth asking GitHub about: not at a PR yet, and requested within the last day. */
export const isActiveRun = (run: ClaudeRun, now = Date.now()) => run.state !== "pr" && now - Date.parse(run.requestedAt) < 86_400_000;

/** A workflow file that runs the Action. */
export const usesClaudeAction = (workflow: string) => /\buses:\s*["']?anthropics\/claude-code-action@/.test(workflow);

/** The Action's default trigger phrase; it ignores comments without it. */
export const TRIGGER = "@claude";

export const defaultPrompt = (title: string) =>
  `${TRIGGER} Please fix this issue ("${title}") and push a branch with the change. Keep the change focused and add a test if the repo has them.`;

/** Apply a webhook signal to the run it belongs to; unknown runs and backward steps are ignored. */
export function advanceRun(runs: ClaudeRuns, signal: ClaudeSignal, now: string): ClaudeRuns {
  const key = claudeKey(signal.repo, signal.number);
  const run = runs[key];
  if (!run || CLAUDE_STATES.indexOf(signal.kind) < CLAUDE_STATES.indexOf(run.state)) return runs;
  const next: ClaudeRun = { ...run, state: signal.kind, updatedAt: now };
  if (signal.kind === "branch") next.branch = signal.branch;
  if (signal.kind === "pr") next.prUrl = signal.url;
  return { ...runs, [key]: next };
}

/** Runs are kept this long after their last change, then dropped. */
export const CLAUDE_RUN_TTL_MS = 14 * 86_400_000;

export function pruneRuns(runs: ClaudeRuns, now = Date.now()): ClaudeRuns {
  return Object.fromEntries(Object.entries(runs).filter(([, r]) => now - Date.parse(r.updatedAt) < CLAUDE_RUN_TTL_MS));
}

/** Where the row's status pill links: the PR, else a compare view of the branch, else our comment. */
export function runLink(run: ClaudeRun): string {
  if (run.prUrl) return run.prUrl;
  // The comment's origin, so GitHub Enterprise hosts work too.
  if (run.branch) return `${new URL(run.commentUrl).origin}/${run.repo}/compare/${run.branch.split("/").map(encodeURIComponent).join("/")}?expand=1`;
  return run.commentUrl;
}
