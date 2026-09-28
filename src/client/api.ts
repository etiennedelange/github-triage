// The browser's side of the API: a Hono RPC client (typed from src/worker/index.ts) and
// TanStack Query hooks. TanStack Query does what Next's server rendering + cache did for
// the UI: fetch once, share across components, refetch on Refresh.

import { QueryClient, useQuery } from "@tanstack/react-query";
import { hc, type ClientResponse } from "hono/client";

import type { ApiType } from "@/worker";

export const api = hc<ApiType>("/api");

export const queryClient = new QueryClient({
  defaultOptions: {
    // The Hub decides freshness (a minute for the inbox); live updates cover the rest.
    queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

/** A 401 means the session ended: go sign in again rather than render an error. */
async function json<T>(res: ClientResponse<T>): Promise<T> {
  if (res.status === 401) {
    window.location.assign("/auth/login");
    return new Promise<never>(() => {});
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const useSession = () => useQuery({ queryKey: ["session"], queryFn: async () => json(await api.session.$get()), staleTime: Infinity });

export const useInbox = () => useQuery({ queryKey: ["inbox"], queryFn: async () => json(await api.inbox.$get()) });

/** Stars arrive live (a webhook invalidates this); follows have no webhook, so poll for them. */
export const useActivity = () =>
  useQuery({ queryKey: ["activity"], queryFn: async () => json(await api.activity.$get()), refetchInterval: 5 * 60_000 });

export const useRateLimits = () =>
  useQuery({ queryKey: ["rate-limits"], queryFn: async () => json(await api["rate-limits"].$get()), refetchInterval: 60_000 });

/** While the first background scan runs, poll until it lands instead of making you reload. */
export const useSecurity = () =>
  useQuery({
    queryKey: ["security"],
    queryFn: async () => json(await api.security.$get()),
    refetchInterval: (q) => (q.state.data && !q.state.data.ok && q.state.data.error.kind === "scanning" ? 5_000 : false),
  });

/**
 * Refresh: the Hub refetches the inbox from GitHub and returns it. The security scan isn't
 * redone (it's expensive and runs on its own schedule), but the stored one is reread: it may
 * have finished, or dropped a deleted repo, since this tab loaded it.
 */
export async function refreshAll(): Promise<void> {
  const [inbox, activity] = await Promise.all([api.refresh.$post().then(json), api.activity.$post().then(json)]);
  queryClient.setQueryData(["inbox"], inbox);
  queryClient.setQueryData(["activity"], activity);
  await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "rate-limits" || q.queryKey[0] === "security" });
}
