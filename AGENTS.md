# GitHub Triage

A single-user GitHub dashboard: a Vite + React SPA served by a Hono Worker on Cloudflare,
with a Durable Object (`src/edge/hub.ts`) as the only store and cache. See README for setup.

- `src/client/` is the browser app, `src/worker/index.ts` the Worker (auth, webhook, `/api/*`),
  `src/edge/` the Cloudflare side (Hub, auth, webhooks, live protocol), `src/lib/` shared logic.
- Tooling is Vite+ (`vp`): Vite, Vitest, Oxlint and Oxfmt, configured in `vite.config.ts` (tests in
  `vitest.config.mts`, kept apart so they run without workerd). Import test APIs from `vite-plus/test`.
- `pnpm dev` runs the Worker and Durable Object in workerd via `@cloudflare/vite-plugin`.
- Don't share an in-flight promise between requests in the Worker or Durable Object: on
  Workers its I/O belongs to the request that started it, and other requests can hang.
- Checks: `pnpm check` (format, lint, types), `pnpm test`, `pnpm build`. Format with `pnpm format`.
