import { useEffect, useSyncExternalStore } from "react";

import { queryClient, refreshAll } from "@/client/api";
import { serverEnvelope, type ServerMessage } from "@/edge/protocol";
import type { AlertPatch, ItemPatch } from "@/lib/live";
import { cn } from "@/lib/utils";

/*
 * Live updates from the Hub Durable Object over /api/live. One socket per tab, held in
 * this module so every panel reads the same patches. Patches are keyed by URL and only
 * overlay the fetched snapshot; when anything might have been missed (a gap in `seq`, or
 * events while no tab was open), the tab resyncs by running Refresh once.
 */

type Status = "off" | "connecting" | "live" | "offline";
type State = {
  status: Status;
  items: ReadonlyMap<string, ItemPatch>;
  alerts: ReadonlyMap<string, AlertPatch>;
};

const OFF: State = { status: "off", items: new Map(), alerts: new Map() };
let state: State = OFF;
const listeners = new Set<() => void>();

function update(fn: (s: State) => State) {
  state = fn(state);
  listeners.forEach((l) => l());
}

export function useLive(): State {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
    () => OFF,
  );
}

// ---------- Connection ----------

let socket: WebSocket | undefined;
let users = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let backoff = 1_000;
let lastSeq = 0;
/** Everything up to here is already on screen: the snapshot's fetch time, then each patch's. */
let knownUpTo = 0;
let resyncing = false;

function connect() {
  clearTimeout(retry);
  update((s) => ({ ...s, status: "connecting" }));
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`);
  socket = ws;

  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", fetchedAt: new Date(knownUpTo).toISOString() }));
  ws.onmessage = (e) => {
    const env = serverEnvelope.safeParse(JSON.parse(String(e.data)));
    if (env.success) receive(env.data as unknown as ServerMessage);
  };
  ws.onclose = (e) => {
    if (socket !== ws) return;
    socket = undefined;
    // 4001: signed out elsewhere. No point reconnecting.
    if (!users || e.code === 4001) return update((s) => ({ ...s, status: e.code === 4001 ? "offline" : "off" }));
    update((s) => ({ ...s, status: "offline" }));
    retry = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
}

function receive(msg: ServerMessage) {
  if (msg.type === "welcome" || msg.type === "resync") {
    lastSeq = msg.seq;
    backoff = 1_000;
    update((s) => ({ ...s, status: "live" }));
    if (msg.type === "resync") resync();
    return;
  }
  const gap = msg.seq !== lastSeq + 1;
  lastSeq = msg.seq;
  knownUpTo = Math.max(knownUpTo, msg.at);

  if (msg.type === "item") {
    const { item, sections, at } = msg;
    update((s) => {
      const prev = s.items.get(item.url);
      // Poll windows overlap: an identical repeat keeps its old time so the row doesn't flash again.
      const same = prev && JSON.stringify(prev.item) === JSON.stringify(item) && prev.sections.join() === sections.join();
      return same ? s : { ...s, items: new Map(s.items).set(item.url, { at, item, sections }) };
    });
  } else if (msg.type === "gone") {
    update((s) => {
      const items = new Map(s.items);
      for (const url of msg.urls) items.set(url, { at: msg.at, item: null, sections: [] });
      return { ...s, items };
    });
  } else if (msg.type === "alert") {
    update((s) => ({ ...s, alerts: new Map(s.alerts).set(msg.alert.url, { at: msg.at, alert: msg.alert }) }));
  } else if (msg.type === "alert-gone") {
    update((s) => ({ ...s, alerts: new Map(s.alerts).set(msg.url, { at: msg.at, alert: null }) }));
  } else if (msg.type === "activity") {
    void queryClient.invalidateQueries({ queryKey: ["activity"] });
  } else if (msg.type === "claude") {
    void queryClient.invalidateQueries({ queryKey: ["claude"] });
  }
  if (gap) resync();
}

/** Full refetch through the existing Refresh action; the new snapshot supersedes older patches. */
function resync() {
  if (resyncing) return;
  resyncing = true;
  void refreshAll()
    .catch(() => {}) // offline: the next reconnect asks again
    .finally(() => (resyncing = false));
}

/**
 * Keep a live connection while mounted. `fetchedAt` is the snapshot the page rendered;
 * patches it already includes are dropped.
 */
export function useLiveConnection(enabled: boolean, fetchedAt: string) {
  useEffect(() => {
    const at = Date.parse(fetchedAt);
    knownUpTo = Math.max(knownUpTo, at);
    const prune = <P extends { at: number }>(m: ReadonlyMap<string, P>) => new Map([...m].filter(([, p]) => p.at > at));
    update((s) => ({ ...s, items: prune(s.items), alerts: prune(s.alerts) }));
  }, [fetchedAt]);

  useEffect(() => {
    if (!enabled) return;
    let started = false;
    const start = () => {
      started = true;
      users++;
      if (!socket) connect();
    };
    // Wait for `load`: a socket opened while the page is still loading can keep the
    // browser's loading indicator spinning for as long as the socket stays open.
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
    return () => {
      window.removeEventListener("load", start);
      if (!started || --users) return;
      clearTimeout(retry);
      socket?.close(1000);
    };
  }, [enabled]);
}

const LABEL: Record<Exclude<Status, "off">, string> = {
  connecting: "Connecting…",
  live: "Live: updates appear as they happen on GitHub",
  offline: "Offline: reconnecting. Refresh for the latest.",
};

/** Small status dot for the header. Renders nothing when live updates aren't configured. */
export function LiveStatus() {
  const { status } = useLive();
  if (status === "off") return null;
  return (
    <span role="status" title={LABEL[status]} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        data-status={status}
        className={cn(
          "live-dot relative size-2 rounded-full",
          status === "live" ? "bg-success" : status === "connecting" ? "bg-muted-foreground" : "bg-orange",
        )}
      />
      <span className="hidden sm:inline">{status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Offline"}</span>
    </span>
  );
}
