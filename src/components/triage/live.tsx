import { CircleArrowUp } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { queryClient, refreshAll, useInbox } from "@/client/api";
import { Button } from "@/components/ui/button";
import { serverEnvelope, type ServerMessage } from "@/edge/protocol";
import type { AlertPatch, ItemPatch } from "@/lib/live";
import { ago } from "@/lib/triage";
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
  /** URLs that changed while the tab was hidden: counted in the tab title until you come back. */
  unseen: ReadonlySet<string>;
  /** When you came back to each of those, so its row replays the live glow where you can see it. */
  returned: ReadonlyMap<string, number>;
  /** When the connection last dropped out of live: the board was current up to then. */
  lastLiveAt?: number;
  /** When the connection went down (cleared once live again); 0 when it's down for good. */
  downSince?: number;
  /** A newer build was deployed than the one this tab is running. */
  outdated?: boolean;
};

const OFF: State = { status: "off", items: new Map(), alerts: new Map(), unseen: new Set(), returned: new Map() };
let state: State = OFF;
const listeners = new Set<() => void>();

function update(fn: (s: State) => State) {
  const before = state.unseen.size;
  state = fn(state);
  if (state.unseen.size !== before) showUnseenInTitle(state.unseen.size);
  listeners.forEach((l) => l());
}

// ---------- Changes you missed ----------

let baseTitle: string | undefined;
function showUnseenInTitle(n: number) {
  baseTitle ??= document.title;
  document.title = n ? `(${n}) ${baseTitle}` : baseTitle;
}

/** A patch for `url` arrived: if nobody can see it land, remember it for when they're back. */
function markIfHidden(url: string) {
  if (document.visibilityState !== "hidden") return;
  update((s) => (s.unseen.has(url) ? s : { ...s, unseen: new Set(s.unseen).add(url) }));
}

function onVisible() {
  if (document.visibilityState !== "visible" || !state.unseen.size) return;
  const now = Date.now();
  update((s) => {
    const returned = new Map(s.returned);
    for (const url of s.unseen) returned.set(url, now);
    return { ...s, unseen: new Set(), returned };
  });
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
/**
 * An attempt that hasn't opened by then is dropped and retried: a port forward (devcontainer,
 * tunnel) can accept the connection while the server is down and never answer or close it.
 */
const CONNECT_TIMEOUT_MS = 5_000;

function connect() {
  clearTimeout(retry);
  update((s) => ({ ...s, status: "connecting" }));
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`);
  socket = ws;
  const opening = setTimeout(() => ws.close(), CONNECT_TIMEOUT_MS);

  ws.onopen = () => {
    clearTimeout(opening);
    ws.send(JSON.stringify({ type: "hello", fetchedAt: new Date(knownUpTo).toISOString() }));
  };
  ws.onmessage = (e) => {
    const env = serverEnvelope.safeParse(JSON.parse(String(e.data)));
    if (env.success) receive(env.data as unknown as ServerMessage);
  };
  ws.onclose = (e) => {
    clearTimeout(opening);
    if (socket !== ws) return;
    socket = undefined;
    // 4001: signed out elsewhere. No point reconnecting.
    const lastLiveAt = (s: State) => (s.status === "live" ? Date.now() : s.lastLiveAt);
    if (!users || e.code === 4001) {
      return update((s) => ({
        ...s,
        status: e.code === 4001 ? "offline" : "off",
        lastLiveAt: lastLiveAt(s),
        downSince: e.code === 4001 ? 0 : s.downSince,
      }));
    }
    update((s) => ({ ...s, status: "offline", lastLiveAt: lastLiveAt(s), downSince: s.downSince ?? Date.now() }));
    retry = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
}

function receive(msg: ServerMessage) {
  if (msg.type === "welcome" || msg.type === "resync") {
    lastSeq = msg.seq;
    backoff = 1_000;
    // A Hub from before build IDs sends none: nothing to compare against.
    const outdated = msg.build !== undefined && msg.build !== __BUILD_ID__;
    update((s) => ({ ...s, status: "live", downSince: undefined, outdated: s.outdated || outdated }));
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
    markIfHidden(item.url);
  } else if (msg.type === "gone") {
    update((s) => {
      const items = new Map(s.items);
      for (const url of msg.urls) items.set(url, { at: msg.at, item: null, sections: [] });
      return { ...s, items };
    });
  } else if (msg.type === "alert") {
    update((s) => ({ ...s, alerts: new Map(s.alerts).set(msg.alert.url, { at: msg.at, alert: msg.alert }) }));
    markIfHidden(msg.alert.url);
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
    update((s) => ({
      ...s,
      items: prune(s.items),
      alerts: prune(s.alerts),
      returned: new Map([...s.returned].filter(([, t]) => t > at)),
    }));
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
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("load", start);
      document.removeEventListener("visibilitychange", onVisible);
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

/** Re-render every `ms` while `on`, so relative times stay true. */
function useTick(on: boolean, ms = 30_000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [on, ms]);
}

/**
 * A dropped socket usually reconnects within a second or two (dev cold starts, a deploy, a
 * network blip); only call it offline once it has stayed down this long.
 */
const OFFLINE_GRACE_MS = 5_000;
const downFor = (since: number) => Date.now() - since;

/** Re-render once when the grace period runs out. */
function useGraceEnd(downSince: number | undefined) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (downSince === undefined) return;
    const left = OFFLINE_GRACE_MS - downFor(downSince);
    if (left <= 0) return;
    const id = setTimeout(() => setTick((n) => n + 1), left);
    return () => clearTimeout(id);
  }, [downSince]);
}

/**
 * Header status: whether the board is current. Live needs no timestamp (changes arrive as
 * they happen); offline, or without live updates, it says when the data was last current.
 */
export function LiveStatus() {
  const { status: raw, lastLiveAt, downSince } = useLive();
  useGraceEnd(downSince);
  const down = downSince !== undefined && downFor(downSince) >= OFFLINE_GRACE_MS;
  // Within the grace period a drop reads as reconnecting; after it, reconnect attempts stay "Offline".
  const status: Status = raw === "offline" && !down ? "connecting" : raw === "connecting" && down ? "offline" : raw;
  const inbox = useInbox();
  const fetchedAt = inbox.data?.ok ? Date.parse(inbox.data.data.fetchedAt) : undefined;
  const currentAt = Math.max(lastLiveAt ?? 0, fetchedAt ?? 0) || undefined;
  useTick(status !== "live" && currentAt !== undefined);
  const since = currentAt === undefined ? undefined : ago(new Date(currentAt).toISOString());

  if (status === "off") {
    return since ? <span className="text-xs text-muted-foreground">Synced {since}</span> : null;
  }
  return (
    <span
      role="status"
      title={status === "offline" && since ? `${LABEL.offline} Last current ${since}.` : LABEL[status]}
      className={cn("inline-flex items-center gap-1.5 text-xs", status === "offline" ? "text-orange" : "text-muted-foreground")}
    >
      <span
        data-status={status}
        className={cn(
          "live-dot relative size-2 rounded-full",
          status === "live" ? "bg-success" : status === "connecting" ? "bg-muted-foreground" : "bg-orange",
        )}
      />
      {status === "live" ? (
        <span className="hidden sm:inline">Live</span>
      ) : status === "connecting" ? (
        <span className="hidden sm:inline">Connecting</span>
      ) : (
        // Offline is always named: it's the one state where the board may be out of date.
        <span>Offline{since && <span className="hidden sm:inline"> · current as of {since}</span>}</span>
      )}
    </span>
  );
}

/** Shown once a newer build is deployed: this tab keeps working, but reloading picks up the new one. */
export function NewVersion() {
  const { outdated } = useLive();
  if (!outdated) return null;
  return (
    <Button size="sm" title="A new version of GitHub Triage was deployed. Reload to use it." onClick={() => location.reload()}>
      <CircleArrowUp data-icon="inline-start" />
      <span className="hidden sm:inline">New version:</span> Reload
    </Button>
  );
}
