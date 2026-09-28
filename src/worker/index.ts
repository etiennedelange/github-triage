// The Worker: GitHub sign-in, the webhook, the live socket and a small JSON API, all on
// Hono. It never renders HTML; the React app is static files it serves behind the session.

import { Hono } from "hono";

import { handleAuth, sessionLogin, unauthenticated } from "@/edge/auth";
import { verifyWebhook } from "@/edge/crypto";
import { hubStub, type EdgeEnv } from "@/edge/env";

export { Hub } from "@/edge/hub";

type AppEnv = { Bindings: EdgeEnv; Variables: { login: string } };

const hub = (env: EdgeEnv) => hubStub(env);

/** Local development runs without a GitHub App: allowed only on this machine, never deployed. */
const isLocalhost = (url: string) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);

// The typed API the browser calls (see src/client/api.ts): each route is one Hub call.
const api = new Hono<AppEnv>()
  .get("/session", (c) => c.json({ login: c.get("login"), oauth: Boolean(c.env.GITHUB_CLIENT_ID) }))
  .get("/inbox", async (c) => c.json(await hub(c.env).getInbox()))
  .get("/security", async (c) => c.json(await hub(c.env).getSecurity()))
  .get("/activity", async (c) => c.json(await hub(c.env).getActivity()))
  .post("/activity", async (c) => c.json(await hub(c.env).getActivity(true)))
  .get("/rate-limits", async (c) => c.json(await hub(c.env).getRateLimits()))
  .post("/refresh", async (c) => c.json(await hub(c.env).getInbox(true)))
  .get("/live", (c) => hub(c.env).fetch(c.req.raw));

export type ApiType = typeof api;

const app = new Hono<AppEnv>();

// Public, but only GitHub can sign it.
app.post("/api/github/webhook", async (c) => {
  const body = await c.req.text();
  if (!(await verifyWebhook(c.env.GITHUB_WEBHOOK_SECRET, body, c.req.header("X-Hub-Signature-256") ?? null))) {
    return c.text("Bad signature", 401);
  }
  // Ack immediately; GitHub times out deliveries after 10s.
  c.executionCtx.waitUntil(hub(c.env).webhook(c.req.header("X-GitHub-Delivery") ?? "", c.req.header("X-GitHub-Event") ?? "", JSON.parse(body)));
  return c.body(null, 202);
});

app.all("/auth/*", async (c) => {
  const stub = hub(c.env);
  const res = await handleAuth(c.req.raw, c.env, { saveTokens: (t) => stub.saveTokens(t), signOut: () => stub.signOut() });
  return res ?? c.notFound();
});

// Everything else, including the app's own files, needs a session.
app.use("*", async (c, next) => {
  if (!c.env.GITHUB_CLIENT_ID) {
    if (!isLocalhost(c.req.url)) return c.text("GitHub sign-in isn't configured (GITHUB_CLIENT_ID).", 500);
    c.set("login", "local");
    return next();
  }
  const login = await sessionLogin(c.req.raw, c.env);
  if (!login) return unauthenticated(c.req.raw);
  c.set("login", login);
  return next();
});

app.route("/api", api);

// The SPA: static files, with index.html for any other path (wrangler.jsonc `not_found_handling`).
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
