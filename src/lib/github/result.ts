// Failures travel as values (API JSON and Durable Object RPC), so the UI can show
// "sign in" or "scanning" instead of a generic error.

import { z } from "zod";

import { GitHubError } from "./http";

export type Failure = { kind: "no-token" | "github" | "unexpected" | "scanning"; message: string; status?: number };
export type Result<T> = { ok: true; data: T } | { ok: false; error: Failure };

export class MissingTokenError extends Error {
  constructor(message = "Not signed in to GitHub.") {
    super(message);
    this.name = "MissingTokenError";
  }
}

/** The first background security scan hasn't finished yet: not an error, just not ready. */
export class ScanPendingError extends Error {
  constructor() {
    super("Scanning your repos for security alerts — this can take a minute on first load.");
    this.name = "ScanPendingError";
  }
}

export function toFailure(err: unknown): Failure {
  if (err instanceof MissingTokenError) return { kind: "no-token", message: err.message };
  if (err instanceof ScanPendingError) return { kind: "scanning", message: err.message };
  if (err instanceof GitHubError) return { kind: "github", message: err.message, status: err.status };
  if (err instanceof z.ZodError) return { kind: "unexpected", message: `Unexpected GitHub response: ${z.prettifyError(err)}` };
  return { kind: "unexpected", message: err instanceof Error ? err.message : String(err) };
}

export async function asResult<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: toFailure(err) };
  }
}
