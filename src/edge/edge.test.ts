import { describe, expect, it, vi } from "vitest";

import { handleAuth, sessionLogin, unauthenticated } from "./auth";
import { hmacHex, signSession, verifySession, verifyWebhook } from "./crypto";
import { changesFor } from "./events";
import { subjectUrls } from "./refetch";
import { TokenKeeper, type StoredTokens } from "./tokens";

describe("webhook signatures", () => {
  it("accepts GitHub's sha256 HMAC over the raw body and nothing else", async () => {
    const body = '{"zen":"Keep it logically awesome."}';
    const good = `sha256=${await hmacHex("s3cret", body)}`;
    expect(await verifyWebhook("s3cret", body, good)).toBe(true);
    expect(await verifyWebhook("s3cret", body + " ", good)).toBe(false);
    expect(await verifyWebhook("other", body, good)).toBe(false);
    expect(await verifyWebhook("s3cret", body, null)).toBe(false);
    expect(await verifyWebhook("s3cret", body, "sha256=zz")).toBe(false);
    expect(await verifyWebhook("", body, good)).toBe(false);
  });
});

describe("session cookie", () => {
  it("round-trips and rejects tampering and expiry", async () => {
    const v = await signSession("k", "octocat", 2_000);
    expect(await verifySession("k", v, 1_000)).toBe("octocat");
    expect(await verifySession("k", v, 2_000)).toBeNull();
    expect(await verifySession("k", v.replace("octocat", "hubot"), 1_000)).toBeNull();
    expect(await verifySession("k", v.replace(".2000.", ".9999.") , 1_000)).toBeNull();
    expect(await verifySession("other", v, 1_000)).toBeNull();
    expect(await verifySession("k", undefined, 1_000)).toBeNull();
  });

  it("drops sessions for logins removed from the allowlist", async () => {
    const v = await signSession("k", "octocat", Date.now() + 60_000);
    const req = new Request("https://t.dev/", { headers: { Cookie: `x=1; __Host-session=${v}` } });
    expect(await sessionLogin(req, { SESSION_SECRET: "k", ALLOWED_LOGINS: "OctoCat, hubot" })).toBe("octocat");
    expect(await sessionLogin(req, { SESSION_SECRET: "k", ALLOWED_LOGINS: "hubot" })).toBeNull();
  });

  it("redirects page loads to sign-in and 401s everything else", () => {
    const page = unauthenticated(new Request("https://t.dev/?repo=a/b", { headers: { Accept: "text/html" } }));
    expect(page.status).toBe(302);
    expect(page.headers.get("Location")).toBe("https://t.dev/auth/login");
    expect(unauthenticated(new Request("https://t.dev/api/live")).status).toBe(401);
    expect(unauthenticated(new Request("https://t.dev/", { method: "POST", headers: { Accept: "text/html" } })).status).toBe(401);
  });
});

describe("OAuth callback", () => {
  const env = { GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "csec", SESSION_SECRET: "k", ALLOWED_LOGINS: "octocat" };
  const callback = (state = "abc", cookieState = "abc") =>
    new Request(`https://t.dev/auth/callback?code=c0de&state=${state}`, { headers: { Cookie: `__Host-oauth-state=${cookieState}` } });

  function github(login: string) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/login/oauth/access_token")) {
        return Response.json({ access_token: "ghu_x", expires_in: 28800, refresh_token: "ghr_y", refresh_token_expires_in: 15811200 });
      }
      if (url.endsWith("/user")) return Response.json({ login });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
  }

  it("starts at GitHub with a state cookie", async () => {
    const res = (await handleAuth(new Request("https://t.dev/auth/login"), env, { saveTokens: vi.fn(), signOut: vi.fn() }))!;
    const location = new URL(res.headers.get("Location")!);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe("https://t.dev/auth/callback");
    expect(res.headers.get("Set-Cookie")).toContain(`__Host-oauth-state=${location.searchParams.get("state")};`);
  });

  it("rejects a state mismatch without talking to GitHub", async () => {
    const fetch = github("octocat");
    const res = (await handleAuth(callback("abc", "evil"), env, { saveTokens: vi.fn(), signOut: vi.fn(), fetch }))!;
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses logins not on the allowlist and stores nothing", async () => {
    const saveTokens = vi.fn();
    const res = (await handleAuth(callback(), env, { saveTokens, signOut: vi.fn(), fetch: github("mallory") }))!;
    expect(res.status).toBe(403);
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it("stores tokens in the Hub and sets a session for allowed logins", async () => {
    const saveTokens = vi.fn();
    const res = (await handleAuth(callback(), env, { saveTokens, signOut: vi.fn(), fetch: github("octocat"), now: () => 1_000 }))!;
    expect(res.status).toBe(302);
    expect(saveTokens).toHaveBeenCalledWith({
      login: "octocat",
      access: "ghu_x",
      accessExpiresAt: 1_000 + 28_800_000,
      refresh: "ghr_y",
      refreshExpiresAt: 1_000 + 15_811_200_000,
    });
    const session = res.headers.getSetCookie().find((c) => c.startsWith("__Host-session="))!;
    expect(session).toMatch(/HttpOnly; Secure; SameSite=Lax/);
  });

  it("only signs out on POST", async () => {
    const signOut = vi.fn();
    expect((await handleAuth(new Request("https://t.dev/auth/logout"), env, { saveTokens: vi.fn(), signOut }))!.status).toBe(405);
    expect(signOut).not.toHaveBeenCalled();
    const res = (await handleAuth(new Request("https://t.dev/auth/logout", { method: "POST" }), env, { saveTokens: vi.fn(), signOut }))!;
    expect(signOut).toHaveBeenCalledOnce();
    expect(res.headers.get("Set-Cookie")).toContain("__Host-session=; ");
  });
});

describe("token refresh", () => {
  function setup(tokens: StoredTokens | undefined, respond: () => Promise<Response>) {
    let stored = tokens;
    const store = { get: async () => stored, put: async (t: StoredTokens) => void (stored = t), delete: async () => void (stored = undefined) };
    const fetch = vi.fn(respond) as unknown as typeof globalThis.fetch;
    const keeper = new TokenKeeper(store, { clientId: "cid", clientSecret: "csec" }, fetch, () => 1_000_000);
    return { keeper, fetch, stored: () => stored };
  }
  const expiring: StoredTokens = { login: "octocat", access: "old", accessExpiresAt: 1_000_000 + 60_000, refresh: "r1", refreshExpiresAt: 9e12 };

  it("serves a fresh token without refreshing", async () => {
    const { keeper, fetch } = setup({ ...expiring, accessExpiresAt: 9e12 }, async () => Response.json({}));
    expect(await keeper.get()).toBe("old");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes once for concurrent callers (refresh tokens are single-use)", async () => {
    const { keeper, fetch, stored } = setup(expiring, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return Response.json({ access_token: "new", expires_in: 28800, refresh_token: "r2", refresh_token_expires_in: 100 });
    });
    const tokens = await Promise.all([keeper.get(), keeper.get(), keeper.get(true)]);
    expect(tokens).toEqual(["new", "new", "new"]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(stored()?.refresh).toBe("r2");
  });

  it("signs out when GitHub rejects the refresh token, but not on network errors", async () => {
    const rejected = setup(expiring, async () => Response.json({ error: "bad_refresh_token" }));
    expect(await rejected.keeper.get()).toBeNull();
    expect(rejected.stored()).toBeUndefined();

    const offline = setup(expiring, async () => {
      throw new TypeError("network");
    });
    expect(await offline.keeper.get()).toBe("old"); // still valid for another minute
    expect(offline.stored()?.refresh).toBe("r1");
  });
});

describe("webhook → changes", () => {
  const repository = { full_name: "acme/api", default_branch: "main" };

  it("reduces PR and issue activity to one subject", () => {
    expect(changesFor("pull_request", { action: "opened", repository, pull_request: { number: 7 } })).toEqual([{ kind: "subject", key: "acme/api#7" }]);
    expect(changesFor("pull_request_review", { action: "submitted", repository, pull_request: { number: 7 } })).toEqual([{ kind: "subject", key: "acme/api#7" }]);
    expect(changesFor("issue_comment", { action: "created", repository, issue: { number: 3 } })).toEqual([{ kind: "subject", key: "acme/api#3" }]);
  });

  it("maps finished check suites to their PRs and ignores the rest", () => {
    const check_suite = { pull_requests: [{ number: 1 }, { number: 2 }] };
    expect(changesFor("check_suite", { action: "completed", repository, check_suite })).toEqual([
      { kind: "subject", key: "acme/api#1" },
      { kind: "subject", key: "acme/api#2" },
    ]);
    expect(changesFor("check_suite", { action: "requested", repository, check_suite })).toEqual([]);
  });

  it("rechecks open PRs only when the default branch moves", () => {
    expect(changesFor("push", { ref: "refs/heads/main", repository })).toEqual([{ kind: "repo-prs", repo: "acme/api" }]);
    expect(changesFor("push", { ref: "refs/heads/feature", repository })).toEqual([]);
  });

  it("carries security alerts in the payload, so no API call is needed", () => {
    const alert = {
      number: 4,
      html_url: "https://github.com/acme/api/security/dependabot/4",
      created_at: "2026-09-01T00:00:00Z",
      security_advisory: { summary: "RCE", severity: "critical" },
      dependency: { package: { name: "x", ecosystem: "npm" } },
    };
    expect(changesFor("dependabot_alert", { action: "created", repository, alert })).toEqual([
      { kind: "alert", alert: expect.objectContaining({ source: "dependabot", severity: "critical", repo: "acme/api", url: alert.html_url }) },
    ]);
    expect(changesFor("dependabot_alert", { action: "fixed", repository, alert })).toEqual([{ kind: "alert-gone", url: alert.html_url }]);
    expect(changesFor("secret_scanning_alert", { action: "created", repository, alert: { number: 9, html_url: "u" } })).toEqual([
      { kind: "alert-refetch", repo: "acme/api", source: "secret-scanning", number: 9 },
    ]);
  });

  it("ignores unknown events and malformed payloads", () => {
    expect(changesFor("star", { action: "created", repository })).toEqual([]);
    expect(changesFor("pull_request", "nope")).toEqual([]);
  });

  it("knows both URLs a missing subject could have been shown under", () => {
    expect(subjectUrls("acme/api#7")).toEqual(["https://github.com/acme/api/pull/7", "https://github.com/acme/api/issues/7"]);
  });
});
