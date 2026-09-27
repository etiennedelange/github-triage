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

The token is used server-side only. Don't expose the server beyond your machine: anyone who can load the page sees what your token can see.

### Security alert coverage

Security alerts are fetched per repo (3 calls each, up to `TRIAGE_MAX_REPOS`). When a scanner has no data for a repo, the panel footer says whether it's turned off or whether the token lacks permission (HTTP 403), so an empty list is never a false all-clear. The `gh` CLI's default token has no `security_events` scope; add it with `gh auth refresh -s security_events`.

### Caching

GitHub data is cached with Next.js Cache Components: the PR/issue inbox (a single GraphQL request) for about a minute, and security scans for about 15 minutes. **Refresh** clears both.

## Development

Open the repository in its dev container (VS Code: **Dev Containers: Clone Repository in Container Volume**). The container provides Node.js 24, pnpm via Corepack, the GitHub CLI and Claude Code. Claude's configuration lives in a per-container volume, so run `claude` once to sign in and `gh auth login` to authenticate the GitHub CLI.

```sh
pnpm test        # Vitest: triage rules, alert normalization
pnpm typecheck
pnpm lint
pnpm build
```

Stack: Next.js 16 (App Router, Cache Components), TypeScript, Tailwind CSS 4, shadcn/ui (radix-vega), Zod at the GitHub API boundary, Lucide, next-themes.

`GITHUB_API_URL` points the app at a different API root (GraphQL at `${GITHUB_API_URL}/graphql`), which is handy for testing against a mock server.

Layout: `src/lib/github/` does the fetching (`client.ts` for auth and HTTP, `data.ts` for cached queries). `src/lib/triage.ts` holds the pure rules and schemas. `src/components/triage/` is the UI.
