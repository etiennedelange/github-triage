import "server-only";

import * as http from "./http";
import { GitHubError } from "./http";

export { GitHubError, mapLimit } from "./http";

// Overridable for tests / mock servers; GraphQL is expected at `${API}/graphql`.
const API = process.env.GITHUB_API_URL?.replace(/\/$/, "") || http.DEFAULT_API;

export class MissingTokenError extends Error {
  constructor() {
    super(
      oauthEnabled()
        ? "Not signed in to GitHub."
        : "No GitHub token found. Set GITHUB_TOKEN or run `gh auth login`.",
    );
    this.name = "MissingTokenError";
  }
}

/** Deployed: tokens come from the GitHub App's OAuth flow, held by the Hub Durable Object. */
export function oauthEnabled(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID);
}

// The value, not a promise: an in-flight promise shared across requests can hang on Workers.
let localToken: string | undefined;

/** Local mode: GITHUB_TOKEN wins, else borrow the GitHub CLI's token. Never sent to the client. */
async function getLocalToken(): Promise<string> {
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (localToken) return localToken;
  try {
    // Lazy: child_process doesn't exist on Workers, and this path never runs there.
    const [{ execFile }, { promisify }] = await Promise.all([import("node:child_process"), import("node:util")]);
    const { stdout } = await promisify(execFile)("gh", ["auth", "token"], { timeout: 5_000 });
    // Failures aren't memoized, so logging in later works without a restart.
    localToken = stdout.trim() || undefined;
  } catch {
    // gh missing or not logged in
  }
  if (!localToken) throw new MissingTokenError();
  return localToken;
}

/** OAuth mode: the Hub owns the tokens and serializes refreshes (GitHub refresh tokens are single-use). */
async function getHubToken(force: boolean): Promise<string> {
  const { hub } = await import("@/edge/binding");
  const token = await (await hub()).getToken(force);
  if (!token) throw new MissingTokenError();
  return token;
}

export async function withToken<T>(fn: (auth: http.GitHubAuth) => Promise<T>): Promise<T> {
  if (!oauthEnabled()) return fn({ token: await getLocalToken(), api: API });
  try {
    return await fn({ token: await getHubToken(false), api: API });
  } catch (err) {
    // A token revoked or expired early: refresh once, then give up.
    if (!(err instanceof GitHubError && err.status === 401)) throw err;
    return fn({ token: await getHubToken(true), api: API });
  }
}

export function rest<T>(path: string): Promise<T> {
  return withToken((auth) => http.rest<T>(auth, path));
}

export function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  return withToken((auth) => http.graphql<T>(auth, query, variables));
}
