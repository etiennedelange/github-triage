import { z } from "zod";

// ---------- Pull requests & issues (GraphQL search nodes) ----------

const label = z.object({ name: z.string(), color: z.string() });
const actor = z.object({ login: z.string() }).nullable();
// A User (login), a Team (slug + org), or null/other for deleted accounts, bots and mannequins.
const reviewer = z
  .object({ login: z.string().optional(), slug: z.string().optional(), organization: z.object({ login: z.string() }).optional() })
  .nullable();

const baseItem = {
  number: z.number(),
  title: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: actor,
  repository: z.object({ nameWithOwner: z.string(), isArchived: z.boolean() }),
  labels: z.object({ nodes: z.array(label) }),
  comments: z.object({ totalCount: z.number() }),
};

export const pullRequestNode = z
  .object({
    __typename: z.literal("PullRequest"),
    ...baseItem,
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    reviewRequests: z.object({ nodes: z.array(z.object({ requestedReviewer: reviewer })) }),
    isDraft: z.boolean(),
    reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
    mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
    additions: z.number(),
    deletions: z.number(),
    commits: z.object({
      nodes: z.array(
        z.object({
          commit: z.object({
            statusCheckRollup: z
              .object({ state: z.enum(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]) })
              .nullable(),
          }),
        }),
      ),
    }),
  })
  .transform((n) => ({
    kind: "pr" as const,
    number: n.number,
    title: n.title,
    url: n.url,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    author: n.author?.login ?? "ghost",
    repo: n.repository.nameWithOwner,
    labels: n.labels.nodes,
    comments: n.comments.totalCount,
    open: n.state === "OPEN" && !n.repository.isArchived,
    // Users by login, teams as "org/slug": what `review-requested:@me` matches against.
    reviewers: n.reviewRequests.nodes.flatMap(({ requestedReviewer: r }) =>
      r?.login ? [r.login] : r?.slug && r.organization ? [`${r.organization.login}/${r.slug}`] : [],
    ),
    isDraft: n.isDraft,
    review: n.reviewDecision,
    conflicting: n.mergeable === "CONFLICTING",
    checks: checkState(n.commits.nodes[0]?.commit.statusCheckRollup?.state),
    additions: n.additions,
    deletions: n.deletions,
  }));

export const issueNode = z
  .object({
    __typename: z.literal("Issue"),
    ...baseItem,
    state: z.enum(["OPEN", "CLOSED"]),
    assignees: z.object({ nodes: z.array(z.object({ login: z.string() })) }),
  })
  .transform((n) => ({
    kind: "issue" as const,
    number: n.number,
    title: n.title,
    url: n.url,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    author: n.author?.login ?? "ghost",
    repo: n.repository.nameWithOwner,
    labels: n.labels.nodes,
    comments: n.comments.totalCount,
    open: n.state === "OPEN" && !n.repository.isArchived,
    assignees: n.assignees.nodes.map((a) => a.login),
  }));

export type PullRequest = z.output<typeof pullRequestNode>;
export type Issue = z.output<typeof issueNode>;
export type ChecksState = "passing" | "failing" | "pending" | "none";

function checkState(state: string | undefined): ChecksState {
  switch (state) {
    case "SUCCESS":
      return "passing";
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

/** What the author of a PR should do next. Ordered by urgency. */
export type PrNextStep = "fix-checks" | "resolve-conflicts" | "address-review" | "merge" | "wait" | "draft";

export function prNextStep(pr: PullRequest): PrNextStep {
  if (pr.isDraft) return "draft";
  if (pr.checks === "failing") return "fix-checks";
  if (pr.conflicting) return "resolve-conflicts";
  if (pr.review === "CHANGES_REQUESTED") return "address-review";
  if (pr.review === "APPROVED" && pr.checks !== "pending") return "merge";
  return "wait";
}

const NEXT_STEP_RANK: Record<PrNextStep, number> = {
  "fix-checks": 0,
  "resolve-conflicts": 1,
  "address-review": 2,
  merge: 3,
  wait: 4,
  draft: 5,
};

export function sortByNextStep(prs: PullRequest[]): PullRequest[] {
  return prs.toSorted(
    (a, b) =>
      NEXT_STEP_RANK[prNextStep(a)] - NEXT_STEP_RANK[prNextStep(b)] || b.updatedAt.localeCompare(a.updatedAt),
  );
}

// ---------- Inbox sections ----------

export const INBOX_SECTIONS = ["review", "mine", "incoming", "assigned", "untriaged"] as const;
export type InboxSection = (typeof INBOX_SECTIONS)[number];

export type SectionContext = {
  /** Your login. */
  viewer: string;
  /** Owners whose repos count as yours: you plus TRIAGE_OWNERS. */
  owners: string[];
  /** Teams you're on, as "org/slug". */
  teams: string[];
};

/**
 * Which inbox sections an item belongs in. Mirrors the search queries in `fetchInbox`
 * (and its review/incoming dedupe), so a single item fetched after a webhook lands
 * exactly where a full refetch would have put it.
 */
export function sectionsFor(item: PullRequest | Issue, ctx: SectionContext): InboxSection[] {
  if (!item.open) return [];
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const isMe = (login: string) => eq(login, ctx.viewer);
  const owned = ctx.owners.some((o) => eq(o, item.repo.split("/")[0]));

  if (item.kind === "issue") {
    const out: InboxSection[] = [];
    if (item.assignees.some(isMe)) out.push("assigned");
    if (item.assignees.length === 0 && owned) out.push("untriaged");
    return out;
  }

  const out: InboxSection[] = [];
  const requested = item.reviewers.some((r) => isMe(r) || ctx.teams.some((t) => eq(t, r)));
  if (requested) out.push("review");
  if (isMe(item.author)) out.push("mine");
  else if (owned && !requested) out.push("incoming");
  return out;
}

// ---------- Security alerts (REST) ----------

export const SEVERITIES = ["critical", "high", "medium", "low", "unknown"] as const;
export type Severity = (typeof SEVERITIES)[number];

function severity(value: string | null | undefined): Severity {
  const v = value?.toLowerCase();
  if (v === "moderate") return "medium";
  if (v === "error") return "high";
  if (v === "warning") return "medium";
  if (v === "note") return "low";
  return (SEVERITIES as readonly string[]).includes(v ?? "") ? (v as Severity) : "unknown";
}

export const dependabotAlert = z
  .object({
    number: z.number(),
    html_url: z.string(),
    created_at: z.string(),
    security_advisory: z.object({ summary: z.string(), severity: z.string() }),
    dependency: z.object({
      package: z.object({ name: z.string(), ecosystem: z.string() }).nullish(),
      manifest_path: z.string().nullish(),
    }),
  })
  .transform((a) => ({
    source: "dependabot" as const,
    number: a.number,
    url: a.html_url,
    createdAt: a.created_at,
    severity: severity(a.security_advisory.severity),
    title: a.security_advisory.summary,
    detail: a.dependency.package
      ? `${a.dependency.package.ecosystem}/${a.dependency.package.name}`
      : (a.dependency.manifest_path ?? ""),
  }));

export const codeScanningAlert = z
  .object({
    number: z.number(),
    html_url: z.string(),
    created_at: z.string(),
    rule: z.object({
      id: z.string().nullish(),
      description: z.string().nullish(),
      severity: z.string().nullish(),
      security_severity_level: z.string().nullish(),
    }),
    tool: z.object({ name: z.string().nullish() }),
    most_recent_instance: z.object({ location: z.object({ path: z.string().nullish() }).nullish() }).nullish(),
  })
  .transform((a) => ({
    source: "code-scanning" as const,
    number: a.number,
    url: a.html_url,
    createdAt: a.created_at,
    // Prefer the CVSS-derived level; fall back to the rule's error/warning/note.
    severity: severity(a.rule.security_severity_level ?? a.rule.severity),
    title: a.rule.description ?? a.rule.id ?? "Code scanning alert",
    detail: [a.tool.name, a.most_recent_instance?.location?.path].filter(Boolean).join(" · "),
  }));

export const secretScanningAlert = z
  .object({
    number: z.number(),
    html_url: z.string(),
    created_at: z.string(),
    secret_type_display_name: z.string().nullish(),
    secret_type: z.string().nullish(),
  })
  .transform((a) => ({
    source: "secret-scanning" as const,
    number: a.number,
    url: a.html_url,
    createdAt: a.created_at,
    // A leaked credential is exploitable as-is, so it outranks everything.
    severity: "critical" as Severity,
    title: `Exposed ${a.secret_type_display_name ?? a.secret_type ?? "secret"}`,
    detail: "",
  }));

export type AlertSource = "dependabot" | "code-scanning" | "secret-scanning";
export type SecurityAlert = (
  | z.output<typeof dependabotAlert>
  | z.output<typeof codeScanningAlert>
  | z.output<typeof secretScanningAlert>
) & { repo: string };

/** Why a scanner produced no data for a repo, so the UI can say so instead of showing a false zero. */
export type ScannerStatus = "ok" | "disabled" | "forbidden" | "error";

export function sortAlerts(alerts: SecurityAlert[]): SecurityAlert[] {
  return alerts.toSorted(
    (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || b.createdAt.localeCompare(a.createdAt),
  );
}

export function countBySeverity(alerts: SecurityAlert[]): Record<Severity, number> {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const a of alerts) counts[a.severity]++;
  return counts;
}

// ---------- Presentation helpers ----------

export function relativeAge(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo` : `${Math.floor(months / 12)}y`;
}

export const STALE_DAYS = 14;

export function isStale(iso: string, now = Date.now()): boolean {
  return now - Date.parse(iso) > STALE_DAYS * 86_400_000;
}

export function filterByRepo<T extends { repo: string }>(items: T[], repo: string | undefined): T[] {
  return repo ? items.filter((i) => i.repo === repo) : items;
}
