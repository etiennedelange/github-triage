// Fictional data for README screenshots: made-up users, orgs and repos, shaped like
// GitHub's GraphQL and REST responses. Times are relative to now so ages read naturally.

export const VIEWER = "demo";
export const OWNERS = [VIEWER, "acme"];
export const REPOS = ["acme/storefront", "acme/api", "acme/design-system", "demo/dotfiles"];

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const LABELS = {
  bug: { name: "bug", color: "d73a4a" },
  deps: { name: "dependencies", color: "0366d6" },
  feature: { name: "feature", color: "a2eeef" },
  perf: { name: "performance", color: "fbca04" },
  docs: { name: "docs", color: "0075ca" },
  security: { name: "security", color: "b60205" },
};
type Label = (typeof LABELS)[keyof typeof LABELS];

type Checks = "SUCCESS" | "FAILURE" | "PENDING" | null;

function pr(o: {
  repo: string;
  number: number;
  title: string;
  author: string;
  hours: number;
  checks?: Checks;
  review?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  conflicting?: boolean;
  draft?: boolean;
  labels?: Label[];
  comments?: number;
  add?: number;
  del?: number;
  reviewers?: string[];
}) {
  return {
    __typename: "PullRequest",
    number: o.number,
    title: o.title,
    url: `https://github.com/${o.repo}/pull/${o.number}`,
    createdAt: ago(o.hours + 30),
    updatedAt: ago(o.hours),
    state: "OPEN",
    author: { login: o.author },
    repository: { nameWithOwner: o.repo, isArchived: false },
    labels: { nodes: o.labels ?? [] },
    comments: { totalCount: o.comments ?? 0 },
    isDraft: o.draft ?? false,
    reviewDecision: o.review ?? null,
    mergeable: o.conflicting ? "CONFLICTING" : "MERGEABLE",
    additions: o.add ?? 12,
    deletions: o.del ?? 4,
    commits: { nodes: o.checks === null ? [] : [{ commit: { statusCheckRollup: { state: o.checks ?? "SUCCESS" } } }] },
    reviewRequests: { nodes: (o.reviewers ?? []).map((login) => ({ requestedReviewer: { login } })) },
  };
}

function issue(o: {
  repo: string;
  number: number;
  title: string;
  author: string;
  hours: number;
  assignees?: string[];
  labels?: Label[];
  comments?: number;
}) {
  return {
    __typename: "Issue",
    number: o.number,
    title: o.title,
    url: `https://github.com/${o.repo}/issues/${o.number}`,
    createdAt: ago(o.hours + 48),
    updatedAt: ago(o.hours),
    state: "OPEN",
    author: { login: o.author },
    repository: { nameWithOwner: o.repo, isArchived: false },
    labels: { nodes: o.labels ?? [] },
    comments: { totalCount: o.comments ?? 0 },
    assignees: { nodes: (o.assignees ?? []).map((login) => ({ login })) },
  };
}

const search = (nodes: unknown[]) => ({ issueCount: nodes.length, nodes });

export function inbox() {
  return {
    viewer: { login: VIEWER, avatarUrl: "http://127.0.0.1:4010/avatar.svg" },
    review: search([
      pr({
        repo: "oss-lab/parser",
        number: 412,
        title: "Stream large files instead of buffering them in memory",
        author: "riley",
        hours: 2,
        add: 184,
        del: 61,
        labels: [LABELS.perf],
        comments: 5,
        reviewers: [VIEWER],
      }),
      pr({
        repo: "acme/api",
        number: 233,
        title: "Add rate limiting to public endpoints",
        author: "sam-ortiz",
        hours: 6,
        checks: "PENDING",
        add: 96,
        del: 8,
        labels: [LABELS.security],
        reviewers: [VIEWER],
      }),
    ]),
    mine: search([
      pr({
        repo: "acme/storefront",
        number: 88,
        title: "Checkout: support saved payment methods",
        author: VIEWER,
        hours: 1,
        checks: "FAILURE",
        add: 342,
        del: 57,
        labels: [LABELS.feature],
        comments: 3,
      }),
      pr({
        repo: "acme/design-system",
        number: 57,
        title: "Tokens: add a high-contrast theme",
        author: VIEWER,
        hours: 20,
        conflicting: true,
        add: 128,
        del: 19,
      }),
      pr({
        repo: "acme/storefront",
        number: 91,
        title: "Fix cart total rounding for mixed currencies",
        author: VIEWER,
        hours: 9,
        review: "CHANGES_REQUESTED",
        add: 22,
        del: 9,
        labels: [LABELS.bug],
        comments: 4,
      }),
      pr({
        repo: "acme/api",
        number: 229,
        title: "Cache product lookups for 60 seconds",
        author: VIEWER,
        hours: 4,
        review: "APPROVED",
        add: 48,
        del: 12,
        labels: [LABELS.perf],
        comments: 2,
      }),
      pr({
        repo: "demo/dotfiles",
        number: 12,
        title: "Switch shell prompt to starship",
        author: VIEWER,
        hours: 120,
        draft: true,
        checks: null,
        add: 30,
        del: 44,
      }),
    ]),
    incoming: search([
      pr({
        repo: "acme/storefront",
        number: 94,
        title: "chore(deps): bump vite from 8.2.0 to 8.3.1",
        author: "dependabot[bot]",
        hours: 3,
        review: "REVIEW_REQUIRED",
        add: 3,
        del: 3,
        labels: [LABELS.deps],
      }),
      pr({
        repo: "acme/api",
        number: 235,
        title: "Docs: explain pagination cursors",
        author: "morgan-ng",
        hours: 26,
        review: "APPROVED",
        add: 64,
        del: 5,
        labels: [LABELS.docs],
        comments: 2,
      }),
      pr({
        repo: "acme/design-system",
        number: 60,
        title: "chore(deps): bump @radix-ui/react-tooltip to 1.3.0",
        author: "dependabot[bot]",
        hours: 30,
        checks: "FAILURE",
        add: 2,
        del: 2,
        labels: [LABELS.deps],
      }),
      pr({
        repo: "acme/api",
        number: 190,
        title: "Experimental GraphQL gateway",
        author: "casey-b",
        hours: 24 * 21,
        conflicting: true,
        add: 1210,
        del: 88,
        comments: 11,
      }),
    ]),
    assigned: search([
      issue({
        repo: "acme/storefront",
        number: 87,
        title: "Search results flicker when filters change",
        author: "morgan-ng",
        hours: 5,
        assignees: [VIEWER],
        labels: [LABELS.bug],
        comments: 3,
      }),
      issue({
        repo: "acme/api",
        number: 221,
        title: "Document the webhook retry policy",
        author: "sam-ortiz",
        hours: 50,
        assignees: [VIEWER],
        labels: [LABELS.docs],
      }),
    ]),
    untriaged: search([
      issue({
        repo: "acme/storefront",
        number: 95,
        title: "Product images load slowly on mobile",
        author: "jamie-q",
        hours: 2,
        labels: [LABELS.perf],
        comments: 1,
      }),
      issue({
        repo: "acme/design-system",
        number: 61,
        title: "Button focus ring is invisible in dark mode",
        author: "riley",
        hours: 14,
        labels: [LABELS.bug],
      }),
      issue({
        repo: "acme/api",
        number: 236,
        title: "Feature request: bulk export endpoint",
        author: "taylor-v",
        hours: 40,
        labels: [LABELS.feature],
        comments: 6,
      }),
    ]),
  };
}

export function rateLimit() {
  const reset = Math.floor(Date.now() / 1000) + 2400;
  return { resources: { graphql: { limit: 5000, remaining: 4987, reset }, core: { limit: 5000, remaining: 4912, reset } } };
}

export function userRepos() {
  return REPOS.map((full_name, i) => ({ full_name, archived: false, fork: false, pushed_at: ago(i * 5) }));
}

const dependabot = (repo: string, number: number, summary: string, severity: string, pkg: string, hours: number) => ({
  number,
  state: "open",
  html_url: `https://github.com/${repo}/security/dependabot/${number}`,
  created_at: ago(hours),
  security_advisory: { summary, severity },
  dependency: { package: { name: pkg, ecosystem: "npm" }, manifest_path: "package.json" },
});

/** Per repo and scanner: alerts, or null when the scanner is off (GitHub answers 404). */
export const ALERTS: Record<string, Record<"dependabot" | "code-scanning" | "secret-scanning", unknown[] | null>> = {
  "acme/storefront": {
    dependabot: [
      dependabot("acme/storefront", 14, "Prototype pollution in deep-merge utility", "critical", "merge-deep", 30),
      dependabot("acme/storefront", 13, "Regular expression denial of service in path matcher", "high", "path-to-regexp", 70),
    ],
    "code-scanning": [
      {
        number: 7,
        state: "open",
        html_url: "https://github.com/acme/storefront/security/code-scanning/7",
        created_at: ago(20),
        rule: { id: "js/xss", description: "Client-side cross-site scripting", severity: "error", security_severity_level: "high" },
        tool: { name: "CodeQL" },
        most_recent_instance: { location: { path: "src/search/results.tsx" } },
      },
    ],
    "secret-scanning": [],
  },
  "acme/api": {
    dependabot: [dependabot("acme/api", 31, "Improper certificate validation in HTTP client", "medium", "undici", 100)],
    "code-scanning": [],
    "secret-scanning": [
      {
        number: 2,
        state: "open",
        html_url: "https://github.com/acme/api/security/secret-scanning/2",
        created_at: ago(8),
        secret_type_display_name: "Stripe API Key",
      },
    ],
  },
  "acme/design-system": {
    dependabot: [dependabot("acme/design-system", 5, "Information exposure in dev server", "low", "vite", 240)],
    "code-scanning": null,
    "secret-scanning": [],
  },
  "demo/dotfiles": { dependabot: [], "code-scanning": null, "secret-scanning": [] },
};

/** Stale branches: `hours` since the last commit; a PR closed an hour after it, if any. */
export function branches() {
  const ref = (name: string, hours: number, pr?: { number: number; state: "OPEN" | "CLOSED" | "MERGED" }, repo = "acme/storefront") => ({
    name,
    target: { committedDate: ago(hours), author: { name: VIEWER, user: { login: VIEWER } } },
    associatedPullRequests: {
      nodes: pr
        ? [{ ...pr, url: `https://github.com/${repo}/pull/${pr.number}`, closedAt: pr.state === "OPEN" ? null : ago(hours - 1) }]
        : [],
    },
  });
  const repo = (nameWithOwner: string, refs: ReturnType<typeof ref>[]) => ({
    nameWithOwner,
    url: `https://github.com/${nameWithOwner}`,
    defaultBranchRef: { name: "main" },
    refs: { totalCount: refs.length + 1, nodes: [ref("main", 2), ...refs] },
  });
  return {
    viewer: {
      repositories: {
        nodes: [
          repo("acme/storefront", [ref("feat/cart-drawer", 30, { number: 412, state: "MERGED" }), ref("spike/edge-cache", 24 * 40)]),
          repo("acme/api", [ref("fix/rate-limit-headers", 50, { number: 88, state: "CLOSED" }, "acme/api")]),
          repo("demo/dotfiles", []),
        ],
      },
    },
  };
}
