# GitHub Triage

A single-user GitHub dashboard: a Vite + React SPA served by a Hono Worker on Cloudflare,
with a Durable Object (`src/edge/hub.ts`) as the only store and cache. See README for setup.

- `src/client/` is the browser app, `src/worker/index.ts` the Worker (auth, webhook, `/api/*`),
  `src/edge/` the Cloudflare side (Hub, auth, webhooks, live protocol), `src/lib/` shared logic.
- `pnpm dev` runs the Worker and Durable Object in workerd via `@cloudflare/vite-plugin`.
- Don't share an in-flight promise between requests in the Worker or Durable Object: on
  Workers its I/O belongs to the request that started it, and other requests can hang.
- Checks: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.
