import "server-only";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Overridable for tests / mock servers; GraphQL is expected at `${API}/graphql`.
const API = process.env.GITHUB_API_URL?.replace(/\/$/, "") || "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export class MissingTokenError extends Error {
  constructor() {
    super("No GitHub token found. Set GITHUB_TOKEN or run `gh auth login`.");
    this.name = "MissingTokenError";
  }
}

let tokenPromise: Promise<string> | undefined;

/** GITHUB_TOKEN wins; otherwise borrow the GitHub CLI's token. Never sent to the client. */
export function getToken(): Promise<string> {
  tokenPromise ??= (async () => {
    const fromEnv = process.env.GITHUB_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    try {
      const { stdout } = await promisify(execFile)("gh", ["auth", "token"], { timeout: 5_000 });
      const token = stdout.trim();
      if (token) return token;
    } catch {
      // gh missing or not logged in
    }
    throw new MissingTokenError();
  })();
  // Don't memoize failure, so logging in later works without a restart.
  tokenPromise.catch(() => (tokenPromise = undefined));
  return tokenPromise;
}

async function headers(): Promise<HeadersInit> {
  return {
    Authorization: `Bearer ${await getToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // Required by GitHub; runtimes like Workers don't add one.
    "User-Agent": "github-triage",
  };
}

export async function rest<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: await headers(), cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new GitHubError(body.message ?? res.statusText, res.status);
  }
  return res.json() as Promise<T>;
}

export async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    errors?: { message: string }[];
    message?: string;
  };
  if (!res.ok) throw new GitHubError(body.message ?? res.statusText, res.status);
  if (body.errors?.length) throw new GitHubError(body.errors.map((e) => e.message).join("; "), 200);
  return body.data as T;
}

/** Run tasks with bounded concurrency so a big account doesn't trip secondary rate limits. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
