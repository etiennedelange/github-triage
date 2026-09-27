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

/** Single user, single Hub. */
export function hubStub(env: Pick<EdgeEnv, "HUB">) {
  return env.HUB.get(env.HUB.idFromName("hub"));
}

export const splitList = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
