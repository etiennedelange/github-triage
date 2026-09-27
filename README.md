# GitHub Triage

One pane for everything on GitHub that's waiting on you: pull requests, issues and security alerts.

| Panel | What's in it |
| --- | --- |
| **Needs your review** | Open PRs where your review is requested |
| **Your pull requests** | Your open PRs, sorted by next step: fix checks → resolve conflicts → address review → ready to merge → awaiting review → draft |
| **Incoming pull requests** | PRs from others (including Dependabot) on your repos |
| **Security alerts** | Open Dependabot, code scanning and secret scanning alerts across your repos, by severity |
| **Assigned to you** | Open issues assigned to you |
| **Untriaged issues** | Open issues on your repos with no assignee |

Click any repo name (or a chip) to filter everything to that repo; the filter lives in the URL (`?repo=owner/name`). Items untouched for 14+ days are marked stale.

The app is **read-only**: it never writes to GitHub.

## Running it

```sh
gh auth login -s security_events   # or put GITHUB_TOKEN in .env.local, see .env.example
pnpm install
pnpm dev                            # http://localhost:3000
```

The token is used server-side only. Don't expose `pnpm dev` beyond your machine: anyone who can load the page sees what your token can see. To host it, deploy to Cloudflare (below), which adds GitHub sign-in.

### Security alert coverage

Security alerts are fetched per repo (3 calls each, up to `TRIAGE_MAX_REPOS`). When a scanner has no data for a repo, the panel footer says whether it's turned off or whether the token lacks permission (HTTP 403), so an empty list is never a false all-clear. The `gh` CLI's default token has no `security_events` scope; add it with `gh auth refresh -s security_events`.

Locally this fan-out runs live, in one request. Deployed, it doesn't: see [Security scans](#security-scans) below.

### Caching

GitHub data is cached with Next.js `unstable_cache`: the PR/issue inbox (a single GraphQL request) for about a minute, and (locally) security scans for about 15 minutes. **Refresh** clears the inbox; deployed, the security scan isn't a cache to clear (see below).

Cache Components (`cacheComponents`, `use cache`) is deliberately **off**: on production Cloudflare Workers it hangs page streaming ([opennextjs/opennextjs-cloudflare#1225](https://github.com/opennextjs/opennextjs-cloudflare/issues/1225)). Worth re-enabling once that's fixed upstream.

## Deploying to Cloudflare

Deployed, the app runs on Cloudflare Workers via [OpenNext](https://opennext.js.org/cloudflare). You sign in with GitHub, and changes on GitHub are pushed to open tabs as they happen.

### How it fits together

`worker.ts` is the Worker entry. It handles these paths before Next:

| Path | What it does |
| --- | --- |
| `/auth/login`, `/auth/callback`, `/auth/logout` | GitHub App OAuth. Only logins in `ALLOWED_LOGINS` get a session (a signed, HttpOnly cookie). Tokens never reach the browser. |
| `/api/github/webhook` | GitHub App webhooks, verified with `X-Hub-Signature-256`. The only path that doesn't need a session. |
| `/api/live` | The dashboard's WebSocket. |
| everything else | The Next app, behind the session check. |

The **Hub** Durable Object (`src/edge/hub.ts`) holds your OAuth tokens and refreshes them. Refresh tokens are single-use, so there's exactly one place that refreshes. It also holds the open tabs' WebSockets, which hibernate so idle tabs cost nothing, and it turns changes into small updates:

- A webhook is reduced to the one PR or issue it's about (`src/edge/events.ts`). A 1.5s debounce collapses bursts, such as 20 check suites finishing, into **one** GraphQL request for just those items. Each item is then filed into panels with the same rules as the inbox searches (`sectionsFor` in `src/lib/triage.ts`), and only that item is pushed.
- Security alert webhooks carry the alert itself, so they're pushed with no API call.
- With no tab open, the Hub does no work. It only notes that something changed, and the next tab to open resyncs once.

The browser overlays these updates on the server-rendered snapshot. A row that arrives or changes glows once. If a tab could have missed something (it was offline, or it was rendered from an older cached snapshot), it runs **Refresh** once.

### Setup

1. **Create a GitHub App** (Settings → Developer settings → GitHub Apps → New):
   - Callback URL: `https://<your-host>/auth/callback`. Leave **Expire user authorization tokens** on.
   - Webhook URL: `https://<your-host>/api/github/webhook`, with a random secret.
   - Repository permissions, all **read-only**: Metadata, Pull requests, Issues, Checks, Commit statuses, Contents, Dependabot alerts, Code scanning alerts, Secret scanning alerts. Organization permission: Members (read), so team review requests count.
   - Subscribe to events: Pull request, Pull request review, Issues, Issue comment, Check suite, Push, Dependabot alert, Code scanning alert, Secret scanning alert. Installation events are sent to every App anyway.
   - Generate a client secret, then **install** the App on your account and on any orgs in `TRIAGE_OWNERS`.
2. **Create the cache resources** and put the D1 id in `wrangler.jsonc`:
   ```sh
   pnpm wrangler r2 bucket create github-triage-opennext-cache
   pnpm wrangler d1 create github-triage-tags
   ```
3. **Set the configuration.** Put `ALLOWED_LOGINS` (your login) and optionally `TRIAGE_OWNERS` in `wrangler.jsonc` → `vars`. Then add the secrets:
   ```sh
   pnpm wrangler secret put GITHUB_CLIENT_ID
   pnpm wrangler secret put GITHUB_CLIENT_SECRET
   pnpm wrangler secret put GITHUB_WEBHOOK_SECRET
   pnpm wrangler secret put SESSION_SECRET        # e.g. openssl rand -hex 32
   ```
4. `pnpm run deploy` (plain `pnpm deploy` is a pnpm built-in)

To try the built Worker locally, copy `.dev.vars.example` to `.dev.vars` and run `pnpm preview` (use a second GitHub App whose callback is `http://localhost:8787/auth/callback`). After changing bindings in `wrangler.jsonc`, run `pnpm cf-typegen`.

### What sign-in changes

- The OAuth token only sees **private** repos where the App is installed. Public repos are unaffected. A review request on someone else's private repo, where your App isn't installed, won't show up.
- Security scans cover the repos the App is installed on (capped by `TRIAGE_MAX_REPOS`), not the owners in `TRIAGE_OWNERS`.

### Security scans

A scan is 3 GitHub calls per repo, which can be well over Cloudflare Workers' per-invocation subrequest limit (a page-render Worker invocation would trip it directly). So deployed, the Hub Durable Object owns scanning instead of the page request: it runs a bounded batch of repo/scanner calls per alarm tick (`src/edge/hub.ts`), checkpointing progress in its own storage and resuming on the next tick until a full pass completes, then stores the result. The dashboard just reads whatever the Hub last finished. A page load only kicks off a new scan when the stored one is missing or older than 15 minutes; while a scan is running (typically only ever on first deploy) the panel shows "Scanning" instead of an error.

### Realtime coverage

| Where | How it updates |
| --- | --- |
| Repos with the App installed | Webhooks, typically within about 2s |
| Other repos (e.g. a review request on a public repo) | A search for PRs and issues involving you that changed since the last check, every 2 minutes and only while a tab is open |
| Checks on PRs from forks, commit statuses (the older API that some CI services still use) | On the next Refresh or resync |

## Development

Open the repository in its dev container (VS Code: **Dev Containers: Clone Repository in Container Volume**). The container provides Node.js 24, pnpm via Corepack, the GitHub CLI and Claude Code. Claude's configuration lives in a per-container volume, so run `claude` once to sign in and `gh auth login` to authenticate the GitHub CLI.

```sh
pnpm test        # Vitest: triage rules, alert normalization
pnpm typecheck
pnpm lint
pnpm build
```

Stack: Next.js 16 (App Router) on Cloudflare Workers via OpenNext, a Durable Object for tokens and live updates, TypeScript, Tailwind CSS 4, shadcn/ui (radix-vega), Zod at the GitHub API boundary, Lucide, next-themes.

`GITHUB_API_URL` points the app at a different API root (GraphQL at `${GITHUB_API_URL}/graphql`), which is handy for testing against a mock server.

Layout: `src/lib/github/` does the fetching (`http.ts` is runtime-agnostic HTTP, `client.ts` resolves the token, `data.ts` holds cached queries). `src/edge/` is the Cloudflare side: auth, webhooks, the Hub Durable Object and the live protocol. `src/lib/triage.ts` holds the pure rules and schemas. `src/components/triage/` is the UI.
