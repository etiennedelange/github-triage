import { describe, expect, it } from "vitest";

import { advanceRun, branchForRun, claudeBranchIssue, claudeBranchTime, claudeKey, isActiveRun, pruneRuns, runLink, usesClaudeAction, type ClaudeRun, type ClaudeRuns } from "./claude";

const run: ClaudeRun = {
  repo: "Acme/api",
  number: 3,
  state: "requested",
  requestedAt: "2026-09-28T10:00:00Z",
  updatedAt: "2026-09-28T10:00:00Z",
  commentUrl: "https://github.com/Acme/api/issues/3#issuecomment-1",
};
const runs: ClaudeRuns = { [claudeKey(run.repo, run.number)]: run };
const now = "2026-09-28T10:05:00Z";

describe("Claude runs", () => {
  it("moves forward on signals, matching the repo case-insensitively", () => {
    const working = advanceRun(runs, { kind: "working", repo: "acme/api", number: 3 }, now);
    expect(working["acme/api#3"]).toMatchObject({ state: "working", updatedAt: now });
    const branch = advanceRun(working, { kind: "branch", repo: "acme/api", number: 3, branch: "claude/issue-3-x" }, now);
    expect(branch["acme/api#3"]).toMatchObject({ state: "branch", branch: "claude/issue-3-x" });
    // The Action keeps editing its comment after pushing: that mustn't move the run back.
    expect(advanceRun(branch, { kind: "working", repo: "acme/api", number: 3 }, now)).toBe(branch);
  });

  it("ignores signals for issues nobody asked Claude about", () => {
    expect(advanceRun(runs, { kind: "working", repo: "acme/api", number: 4 }, now)).toBe(runs);
  });

  it("links to the PR, else the branch's compare view, else the comment", () => {
    expect(runLink(run)).toBe(run.commentUrl);
    expect(runLink({ ...run, branch: "claude/issue-3-x" })).toBe("https://github.com/Acme/api/compare/claude/issue-3-x?expand=1");
    expect(runLink({ ...run, branch: "claude/issue-3-x", prUrl: "p" })).toBe("p");
  });

  it("drops runs untouched for two weeks", () => {
    expect(pruneRuns(runs, Date.parse(now))).toEqual(runs);
    expect(pruneRuns(runs, Date.parse("2026-10-13T10:00:00Z"))).toEqual({});
  });
});

describe("Claude Action detection", () => {
  it("reads the issue number from the Action's branch names only", () => {
    expect(claudeBranchIssue("claude/issue-42-20260928-1200")).toBe(42);
    expect(claudeBranchIssue("claude/pr-42-20260928-1200")).toBeUndefined();
    expect(claudeBranchIssue("feature/issue-42-x")).toBeUndefined();
  });

  it("dates branches from their suffix and ignores ones from before the run", () => {
    expect(claudeBranchTime("claude/issue-3-20260928-1005")).toBe(Date.parse("2026-09-28T10:05:00Z"));
    expect(claudeBranchTime("claude/issue-3-x")).toBeUndefined();
    // Requested 10:00:00: the same minute counts, the day before doesn't.
    expect(branchForRun(run, ["claude/issue-3-20260927-1000", "claude/issue-3-20260928-1000", "claude/issue-4-20260928-1001"])).toBe(
      "claude/issue-3-20260928-1000",
    );
    expect(branchForRun(run, ["claude/issue-3-20260927-1000"])).toBeUndefined();
  });

  it("stops checking a run once it has a PR or is a day old", () => {
    const at = Date.parse(now);
    expect(isActiveRun(run, at)).toBe(true);
    expect(isActiveRun({ ...run, state: "pr" }, at)).toBe(false);
    expect(isActiveRun(run, Date.parse("2026-09-29T10:00:01Z"))).toBe(false);
  });

  it("spots the Action in a workflow file", () => {
    expect(usesClaudeAction("steps:\n  - uses: anthropics/claude-code-action@v1\n")).toBe(true);
    expect(usesClaudeAction("- uses: 'anthropics/claude-code-action@beta'")).toBe(true);
    expect(usesClaudeAction("# see anthropics/claude-code-action for setup\n- uses: actions/checkout@v4")).toBe(false);
  });
});
