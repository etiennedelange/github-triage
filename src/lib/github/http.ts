// GitHub HTTP with no env reads: callers (the Hub Durable Object) pass the token.

export const DEFAULT_API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export type GitHubAuth = { token: string; api?: string };

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // Required by GitHub; runtimes like Workers don't add one.
    "User-Agent": "github-triage",
  };
}

const base = (api?: string) => (api ?? DEFAULT_API).replace(/\/$/, "");

/** A GET, or a POST when `body` is given. */
export async function rest<T>({ token, api }: GitHubAuth, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base(api)}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: headers(token),
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new GitHubError(body.message ?? res.statusText, res.status);
  }
  return res.json() as Promise<T>;
}

/**
 * `partial`: return whatever data came back alongside errors, for batched lookups where one
 * missing repo or item (deleted, no access) shouldn't sink the rest.
 */
export async function graphql<T>(
  { token, api }: GitHubAuth,
  query: string,
  variables: Record<string, unknown>,
  { partial = false, onErrors }: { partial?: boolean; onErrors?: (errors: GraphQLErrorEntry[]) => void } = {},
): Promise<T> {
  const res = await fetch(`${base(api)}/graphql`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: T;
    errors?: GraphQLErrorEntry[];
    message?: string;
  };
  if (!res.ok) throw new GitHubError(body.message ?? res.statusText, res.status);
  if (body.errors?.length && !(partial && body.data)) throw new GitHubError(describeErrors(body.errors), 200);
  if (body.errors?.length) onErrors?.(body.errors);
  return body.data as T;
}

export type GraphQLErrorEntry = { message: string; path?: (string | number)[] };

/** One line per distinct message, with a few of the fields it hit: GitHub repeats it per node. */
export function describeErrors(errors: GraphQLErrorEntry[]): string {
  const byMessage = new Map<string, string[]>();
  for (const e of errors) byMessage.set(e.message, [...(byMessage.get(e.message) ?? []), ...(e.path ? [e.path.join(".")] : [])]);
  return [...byMessage]
    .map(([message, paths]) => {
      if (!paths.length) return message;
      const shown = paths.slice(0, 3).join(", ");
      return `${message} (${errors.filter((e) => e.message === message).length}×, at ${shown}${paths.length > 3 ? ", …" : ""})`;
    })
    .join("; ");
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
