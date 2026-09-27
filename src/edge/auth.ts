// Sign in with the GitHub App's OAuth flow. Plain fetch handlers, so they run in the Worker
// entry before Next and are testable without a runtime.

import { randomToken, signSession, verifySession } from "./crypto";
import { splitList } from "./env";
import { parseTokenResponse, requestToken, type StoredTokens } from "./tokens";

export type AuthEnv = {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  ALLOWED_LOGINS: string;
  GITHUB_API_URL?: string;
};

export type AuthDeps = {
  saveTokens(tokens: StoredTokens): Promise<void>;
  signOut(): Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
};

const SESSION_COOKIE = "__Host-session";
const STATE_COOKIE = "__Host-oauth-state";
const SESSION_DAYS = 30;

function readCookie(req: Request, name: string): string | undefined {
  for (const part of req.headers.get("Cookie")?.split(";") ?? []) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
}

const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export function isAllowed(env: Pick<AuthEnv, "ALLOWED_LOGINS">, login: string): boolean {
  return splitList(env.ALLOWED_LOGINS).some((l) => l.toLowerCase() === login.toLowerCase());
}

/** The signed-in login, if the session cookie is valid and the login is still on the allowlist. */
export async function sessionLogin(req: Request, env: Pick<AuthEnv, "SESSION_SECRET" | "ALLOWED_LOGINS">, now = Date.now()) {
  const login = await verifySession(env.SESSION_SECRET, readCookie(req, SESSION_COOKIE), now);
  return login && isAllowed(env, login) ? login : null;
}

/** Page loads go to sign-in; everything else (fetches, sockets, server actions) gets a 401. */
export function unauthenticated(req: Request): Response {
  const wantsPage = req.method === "GET" && (req.headers.get("Accept") ?? "").includes("text/html");
  return wantsPage ? Response.redirect(new URL("/auth/login", req.url).toString(), 302) : new Response("Unauthorized", { status: 401 });
}

/** Handles /auth/*; null for any other path. */
export async function handleAuth(req: Request, env: AuthEnv, deps: AuthDeps): Promise<Response | null> {
  const url = new URL(req.url);
  const now = deps.now ?? Date.now;
  const fetchFn = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  switch (url.pathname) {
    case "/auth/login": {
      const state = randomToken();
      const authorize = new URL("https://github.com/login/oauth/authorize");
      authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      authorize.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
      authorize.searchParams.set("state", state);
      return new Response(null, {
        status: 302,
        headers: { Location: authorize.toString(), "Set-Cookie": cookie(STATE_COOKIE, state, 600) },
      });
    }

    case "/auth/callback": {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state || state !== readCookie(req, STATE_COOKIE)) {
        return page(400, "Sign-in expired", "That sign-in link is stale or was opened in another browser.", "Try again");
      }
      const exchange = await requestToken(
        { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
        { code, redirect_uri: `${url.origin}/auth/callback` },
        fetchFn,
      );
      const tokens = exchange.ok ? parseTokenResponse(exchange.body, "", now()) : null;
      if (!tokens) return page(502, "GitHub didn't sign you in", "The code exchange failed. It may have been used already.", "Try again");

      const api = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
      const me = await fetchFn(`${api}/user`, {
        headers: { Authorization: `Bearer ${tokens.access}`, Accept: "application/vnd.github+json", "User-Agent": "github-triage" },
      });
      const login = me.ok ? ((await me.json()) as { login?: string }).login : undefined;
      if (!login) return page(502, "GitHub didn't sign you in", "Couldn't read your GitHub account.", "Try again");
      if (!isAllowed(env, login)) {
        return page(403, "Not on the list", `@${login} isn't allowed to use this dashboard. Add it to ALLOWED_LOGINS.`);
      }

      await deps.saveTokens({ ...tokens, login });
      const session = await signSession(env.SESSION_SECRET, login, now() + SESSION_DAYS * 86_400_000);
      const headers = new Headers({ Location: "/" });
      headers.append("Set-Cookie", cookie(SESSION_COOKIE, session, SESSION_DAYS * 86_400));
      headers.append("Set-Cookie", cookie(STATE_COOKIE, "", 0));
      return new Response(null, { status: 302, headers });
    }

    case "/auth/logout": {
      // POST only, so a stray link or prefetch can't sign you out.
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      await deps.signOut();
      return new Response(page(200, "Signed out", "Your GitHub tokens were deleted from this deployment.", "Sign in").body, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": cookie(SESSION_COOKIE, "", 0) },
      });
    }

    default:
      return null;
  }
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A tiny standalone page: these responses happen outside Next, before there's a session. */
function page(status: number, title: string, message: string, action?: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · GitHub Triage</title><meta name="color-scheme" content="light dark">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}
main{max-width:22rem;padding:1.5rem;border:1px solid color-mix(in srgb,CanvasText 15%,transparent);border-radius:12px}
h1{font-size:1rem;margin:0 0 .5rem}p{margin:0 0 1rem;opacity:.75}a{display:inline-block;padding:.4rem .8rem;border-radius:8px;background:CanvasText;color:Canvas;text-decoration:none;font-weight:500}</style>
</head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p>${action ? `<a href="/auth/login">${escape(action)}</a>` : ""}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
