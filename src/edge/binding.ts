import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { hubStub, type EdgeEnv } from "./env";

/** The Hub Durable Object, reached from Next server code via the Worker's bindings. */
export async function hub() {
  const { env } = await getCloudflareContext({ async: true });
  return hubStub(env as unknown as EdgeEnv);
}
