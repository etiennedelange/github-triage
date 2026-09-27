// GitHub App user access tokens: 8h access token + single-use refresh token (6 months).
// Lives in the Hub Durable Object so there is exactly one place that refreshes.

import { z } from "zod";

export type StoredTokens = {
  login: string;
  access: string;
  /** Epoch ms; 0 when the App has token expiry turned off. */
  accessExpiresAt: number;
  refresh: string | null;
  refreshExpiresAt: number | null;
};

export type TokenStore = {
  get(): Promise<StoredTokens | undefined>;
  put(tokens: StoredTokens): Promise<void>;
  delete(): Promise<void>;
};

export type OAuthApp = { clientId: string; clientSecret: string };

const TOKEN_URL = "https://github.com/login/oauth/access_token";
/** Refresh this long before expiry, so a token never dies mid-render. */
const REFRESH_EARLY_MS = 5 * 60_000;

const tokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  refresh_token_expires_in: z.number().optional(),
});

/** GitHub answers 200 with `{ error }` on failure, so success is judged by shape, not status. */
export function parseTokenResponse(body: unknown, login: string, now = Date.now()): StoredTokens | null {
  const t = tokenResponse.safeParse(body);
  if (!t.success) return null;
  return {
    login,
    access: t.data.access_token,
    accessExpiresAt: t.data.expires_in ? now + t.data.expires_in * 1000 : 0,
    refresh: t.data.refresh_token ?? null,
    refreshExpiresAt: t.data.refresh_token_expires_in ? now + t.data.refresh_token_expires_in * 1000 : null,
  };
}

/** POST to GitHub's token endpoint: a code exchange or a refresh. */
export async function requestToken(
  app: OAuthApp,
  params: Record<string, string>,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    const res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "github-triage" },
      body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, ...params }),
    });
    if (res.status >= 500) return { ok: false };
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false };
  }
}

export class TokenKeeper {
  private refreshing?: Promise<string | null>;

  constructor(
    private readonly store: TokenStore,
    private readonly app: OAuthApp,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly now: () => number = Date.now,
  ) {}

  /** A usable access token, refreshing if it's (nearly) expired or `force`d after a 401; null = sign in again. */
  async get(force = false): Promise<string | null> {
    const t = await this.store.get();
    if (!t) return null;
    const fresh = t.accessExpiresAt === 0 || t.accessExpiresAt - this.now() > REFRESH_EARLY_MS;
    if (fresh && !force) return t.access;
    // Callers share one in-flight refresh: refresh tokens are single-use, so a second
    // parallel refresh with the same one would fail and sign you out.
    this.refreshing ??= this.refresh(t.access).finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async refresh(stale: string): Promise<string | null> {
    const t = await this.store.get();
    if (!t) return null;
    // Someone else refreshed between our read and now.
    if (t.access !== stale) return t.access;
    if (!t.refresh || (t.refreshExpiresAt && t.refreshExpiresAt <= this.now())) {
      await this.store.delete();
      return null;
    }
    const res = await requestToken(this.app, { grant_type: "refresh_token", refresh_token: t.refresh }, this.fetchFn);
    // Network trouble: keep the tokens and retry on the next call.
    if (!res.ok) return t.accessExpiresAt > this.now() ? t.access : null;
    const next = parseTokenResponse(res.body, t.login, this.now());
    if (!next) {
      // GitHub rejected the refresh token (revoked, reused or expired): sign-in required.
      await this.store.delete();
      return null;
    }
    await this.store.put(next);
    return next.access;
  }
}
