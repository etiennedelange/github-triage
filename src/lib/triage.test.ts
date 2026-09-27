import { describe, expect, it } from "vitest";

import {
  codeScanningAlert,
  countBySeverity,
  dependabotAlert,
  issueNode,
  isStale,
  prNextStep,
  sectionsFor,
  pullRequestNode,
  relativeAge,
  secretScanningAlert,
  sortAlerts,
  sortByNextStep,
  type PullRequest,
  type SecurityAlert,
} from "./triage";

function pr(overrides: Partial<{
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checks: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null;
  updatedAt: string;
  number: number;
  author: string;
  repo: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  archived: boolean;
  reviewers: ({ login: string } | { slug: string; organization: { login: string } } | null)[];
}> = {}): PullRequest {
  return pullRequestNode.parse({
    __typename: "PullRequest",
    number: overrides.number ?? 1,
    title: "t",
    url: `https://github.com/${overrides.repo ?? "o/r"}/pull/${overrides.number ?? 1}`,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-09-20T00:00:00Z",
    state: overrides.state ?? "OPEN",
    author: overrides.author ? { login: overrides.author } : null,
    repository: { nameWithOwner: overrides.repo ?? "o/r", isArchived: overrides.archived ?? false },
    reviewRequests: { nodes: (overrides.reviewers ?? []).map((requestedReviewer) => ({ requestedReviewer })) },
    labels: { nodes: [] },
    comments: { totalCount: 0 },
    isDraft: overrides.isDraft ?? false,
    reviewDecision: overrides.reviewDecision ?? null,
    mergeable: overrides.mergeable ?? "MERGEABLE",
    additions: 1,
    deletions: 1,
    commits: {
      nodes: overrides.checks === null ? [] : [{ commit: { statusCheckRollup: { state: overrides.checks ?? "SUCCESS" } } }],
    },
  });
}

describe("pullRequestNode", () => {
  it("normalizes a GraphQL node", () => {
    const p = pr({ checks: "ERROR" });
    expect(p.author).toBe("ghost");
    expect(p.repo).toBe("o/r");
    expect(p.checks).toBe("failing");
  });

  it("treats a PR with no commits/rollup as having no checks", () => {
    expect(pr({ checks: null }).checks).toBe("none");
  });
});

function issue(o: { assignees?: string[]; repo?: string; state?: "OPEN" | "CLOSED" } = {}) {
  return issueNode.parse({
    __typename: "Issue",
    number: 9,
    title: "t",
    url: "https://github.com/x/y/issues/9",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-20T00:00:00Z",
    state: o.state ?? "OPEN",
    author: { login: "someone" },
    repository: { nameWithOwner: o.repo ?? "me/app", isArchived: false },
    labels: { nodes: [] },
    comments: { totalCount: 0 },
    assignees: { nodes: (o.assignees ?? []).map((login) => ({ login })) },
  });
}

describe("sectionsFor", () => {
  const ctx = { viewer: "Me", owners: ["me", "acme"], teams: ["acme/web"] };

  it("files PRs like the inbox searches do", () => {
    // author:@me, on any repo
    expect(sectionsFor(pr({ author: "me", repo: "elsewhere/lib" }), ctx)).toEqual(["mine"]);
    // review-requested:@me, directly or through a team, on any repo
    expect(sectionsFor(pr({ author: "bob", repo: "elsewhere/lib", reviewers: [{ login: "ME" }] }), ctx)).toEqual(["review"]);
    expect(sectionsFor(pr({ author: "bob", repo: "elsewhere/lib", reviewers: [{ slug: "web", organization: { login: "acme" } }] }), ctx)).toEqual(["review"]);
    // user:<owners> -author:@me, minus anything already in review
    expect(sectionsFor(pr({ author: "bob", repo: "acme/api" }), ctx)).toEqual(["incoming"]);
    expect(sectionsFor(pr({ author: "bob", repo: "acme/api", reviewers: [{ login: "me" }] }), ctx)).toEqual(["review"]);
    // someone else's PR on someone else's repo
    expect(sectionsFor(pr({ author: "bob", repo: "elsewhere/lib", reviewers: [null, { login: "carol" }] }), ctx)).toEqual([]);
  });

  it("drops closed, merged and archived items from every section", () => {
    expect(sectionsFor(pr({ author: "me", state: "MERGED" }), ctx)).toEqual([]);
    expect(sectionsFor(pr({ author: "me", state: "CLOSED" }), ctx)).toEqual([]);
    expect(sectionsFor(pr({ author: "me", archived: true }), ctx)).toEqual([]);
    expect(sectionsFor(issue({ assignees: ["me"], state: "CLOSED" }), ctx)).toEqual([]);
  });

  it("files issues as assigned or untriaged", () => {
    expect(sectionsFor(issue({ assignees: ["me"], repo: "elsewhere/lib" }), ctx)).toEqual(["assigned"]);
    expect(sectionsFor(issue({ assignees: [], repo: "acme/api" }), ctx)).toEqual(["untriaged"]);
    expect(sectionsFor(issue({ assignees: [], repo: "elsewhere/lib" }), ctx)).toEqual([]);
    expect(sectionsFor(issue({ assignees: ["bob"], repo: "me/app" }), ctx)).toEqual([]);
  });
});

describe("prNextStep", () => {
  it("puts drafts aside regardless of other state", () => {
    expect(prNextStep(pr({ isDraft: true, checks: "FAILURE" }))).toBe("draft");
  });

  it("prioritizes failing checks, then conflicts, then requested changes", () => {
    expect(prNextStep(pr({ checks: "FAILURE", mergeable: "CONFLICTING", reviewDecision: "CHANGES_REQUESTED" }))).toBe("fix-checks");
    expect(prNextStep(pr({ mergeable: "CONFLICTING", reviewDecision: "CHANGES_REQUESTED" }))).toBe("resolve-conflicts");
    expect(prNextStep(pr({ reviewDecision: "CHANGES_REQUESTED" }))).toBe("address-review");
  });

  it("is mergeable only once approved and checks have settled", () => {
    expect(prNextStep(pr({ reviewDecision: "APPROVED" }))).toBe("merge");
    expect(prNextStep(pr({ reviewDecision: "APPROVED", checks: null }))).toBe("merge");
    expect(prNextStep(pr({ reviewDecision: "APPROVED", checks: "PENDING" }))).toBe("wait");
    expect(prNextStep(pr({ reviewDecision: "REVIEW_REQUIRED" }))).toBe("wait");
  });

  it("sorts by urgency, then most recently updated", () => {
    const sorted = sortByNextStep([
      pr({ number: 1, reviewDecision: "APPROVED" }),
      pr({ number: 2, checks: "FAILURE", updatedAt: "2026-09-01T00:00:00Z" }),
      pr({ number: 3, checks: "FAILURE", updatedAt: "2026-09-10T00:00:00Z" }),
      pr({ number: 4, isDraft: true }),
    ]);
    expect(sorted.map((p) => p.number)).toEqual([3, 2, 1, 4]);
  });
});

describe("security alert parsing", () => {
  it("maps Dependabot's 'moderate' to medium and names the package", () => {
    const a = dependabotAlert.parse({
      number: 7,
      html_url: "u",
      created_at: "2026-09-01T00:00:00Z",
      security_advisory: { summary: "Prototype pollution", severity: "moderate" },
      dependency: { package: { name: "lodash", ecosystem: "npm" }, manifest_path: "package.json" },
    });
    expect(a).toMatchObject({ source: "dependabot", severity: "medium", detail: "npm/lodash" });
  });

  it("prefers code scanning's security severity, falling back to rule severity", () => {
    const base = { number: 1, html_url: "u", created_at: "2026-09-01T00:00:00Z", tool: { name: "CodeQL" } };
    expect(codeScanningAlert.parse({ ...base, rule: { id: "x", severity: "warning", security_severity_level: "high" } }).severity).toBe("high");
    expect(codeScanningAlert.parse({ ...base, rule: { id: "x", severity: "error", security_severity_level: null } }).severity).toBe("high");
    expect(codeScanningAlert.parse({ ...base, rule: { id: "x", severity: "note" } }).severity).toBe("low");
    expect(codeScanningAlert.parse({ ...base, rule: { id: "x", severity: "something-new" } }).severity).toBe("unknown");
  });

  it("treats exposed secrets as critical", () => {
    const a = secretScanningAlert.parse({ number: 1, html_url: "u", created_at: "2026-09-01T00:00:00Z", secret_type_display_name: "GitHub PAT" });
    expect(a).toMatchObject({ severity: "critical", title: "Exposed GitHub PAT" });
  });

  it("sorts by severity then newest, and counts per severity", () => {
    const mk = (severity: SecurityAlert["severity"], createdAt: string, number: number) =>
      ({ source: "dependabot", number, url: `${number}`, createdAt, severity, title: "", detail: "", repo: "o/r" }) as SecurityAlert;
    const alerts = [mk("low", "2026-09-05", 1), mk("critical", "2026-09-01", 2), mk("critical", "2026-09-03", 3), mk("unknown", "2026-09-09", 4)];
    expect(sortAlerts(alerts).map((a) => a.number)).toEqual([3, 2, 1, 4]);
    expect(countBySeverity(alerts)).toEqual({ critical: 2, high: 0, medium: 0, low: 1, unknown: 1 });
  });
});

describe("time helpers", () => {
  const now = Date.parse("2026-09-27T12:00:00Z");
  it("formats compact relative ages", () => {
    expect(relativeAge("2026-09-27T11:55:00Z", now)).toBe("5m");
    expect(relativeAge("2026-09-27T09:00:00Z", now)).toBe("3h");
    expect(relativeAge("2026-09-20T12:00:00Z", now)).toBe("7d");
    expect(relativeAge("2026-06-01T12:00:00Z", now)).toBe("3mo");
    expect(relativeAge("2024-01-01T00:00:00Z", now)).toBe("2y");
    expect(relativeAge("2026-09-28T00:00:00Z", now)).toBe("0m");
  });
  it("flags items untouched for over two weeks", () => {
    expect(isStale("2026-09-20T12:00:00Z", now)).toBe(false);
    expect(isStale("2026-09-01T12:00:00Z", now)).toBe(true);
  });
});
