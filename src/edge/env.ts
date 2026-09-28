import type { Hub } from "./hub";

/** Worker bindings: generated ones (cloudflare-env.d.ts) plus the secrets wrangler can't see. */
export type EdgeEnv = Omit<CloudflareEnv, "HUB"> & {
  HUB: DurableObjectNamespace<Hub>;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_WEBHOOK_SECRET: string;
  SESSION_SECRET: string;
  /** Comma-separated GitHub logins allowed to sign in. */
  ALLOWED_LOGINS: string;
  TRIAGE_OWNERS?: string;
  TRIAGE_MAX_REPOS?: string;
  GITHUB_API_URL?: string;
  /** Local development only, when no GitHub App is configured (`.dev.vars`). */
  GITHUB_TOKEN?: string;
};

/** Each GitHub login gets its own Hub; local mode signs in as "local". */
export function hubFor(env: Pick<EdgeEnv, "HUB">, login: string) {
  return env.HUB.get(env.HUB.idFromName(`${HUB_PREFIX}${login.toLowerCase()}`));
}

export const HUB_PREFIX = "login:";
/** The one Hub a deployment had before Hubs were per login. See Hub.adoptLegacy. */
export const LEGACY_HUB = "hub";

export const splitList = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
