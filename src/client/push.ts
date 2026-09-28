// Desktop notifications: this browser's Web Push subscription, kept in step with the Hub.
// The Hub sends them from webhooks (src/edge/notices.ts); public/sw.js shows them.

import { useSyncExternalStore } from "react";

import { fromBase64Url, pushSubscription, toBase64Url } from "@/edge/push";

import { api } from "./api";

export type PushStatus = "unsupported" | "blocked" | "off" | "on" | "busy";
type State = { status: PushStatus; error?: string };

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

let state: State = { status: "busy" };
const listeners = new Set<() => void>();
const set = (next: State) => ((state = next), listeners.forEach((l) => l()));

export const usePush = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
    () => state,
  );

async function serverKey(): Promise<string> {
  const res = await api.push.$get();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()).key;
}

/** Sends the subscription to the Hub; `test` asks it for a notification straight away. */
async function register(sub: PushSubscription, test: boolean): Promise<void> {
  const res = await api.push.$post({ json: { subscription: pushSubscription.parse(sub.toJSON()), test } });
  const result = res.ok ? await res.json() : undefined;
  if (!result?.ok) throw new Error(result && !result.ok ? result.error.message : `${res.status} ${res.statusText}`);
}

async function subscribe(reg: ServiceWorkerRegistration, key: string): Promise<PushSubscription> {
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(key) });
}

/**
 * On load: re-send an existing subscription, since the Hub forgets them on sign-out, and
 * replace one made with a key the Hub no longer has.
 */
export async function initPush(): Promise<void> {
  if (!supported()) return set({ status: "unsupported" });
  if (Notification.permission === "denied") return set({ status: "blocked" });
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    let sub = await reg?.pushManager.getSubscription();
    if (!reg || !sub || Notification.permission !== "granted") return set({ status: "off" });
    const key = await serverKey();
    const current = sub.options.applicationServerKey;
    if (!current || toBase64Url(current) !== key) {
      await sub.unsubscribe();
      sub = await subscribe(reg, key);
    }
    // Picks up a newer sw.js too.
    void reg.update();
    await register(sub, false);
    set({ status: "on" });
  } catch (err) {
    set({ status: "off", error: message(err) });
  }
}

export async function enablePush(): Promise<void> {
  set({ status: "busy" });
  try {
    // Asked from the click, as browsers require.
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return set({ status: permission === "denied" ? "blocked" : "off" });
    const [reg, key] = await Promise.all([
      navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready),
      serverKey(),
    ]);
    const existing = await reg.pushManager.getSubscription();
    const sameKey = existing?.options.applicationServerKey && toBase64Url(existing.options.applicationServerKey) === key;
    if (existing && !sameKey) await existing.unsubscribe();
    const sub = existing && sameKey ? existing : await subscribe(reg, key);
    try {
      await register(sub, true);
    } catch (err) {
      // The Hub has dropped it; drop ours too, or the next load would call it on.
      await sub.unsubscribe().catch(() => {});
      throw err;
    }
    set({ status: "on" });
  } catch (err) {
    set({ status: "off", error: message(err) });
  }
}

export async function disablePush(): Promise<void> {
  set({ status: "busy" });
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api.push.$delete({ json: { endpoint: sub.endpoint } });
      await sub.unsubscribe();
    }
    set({ status: "off" });
  } catch (err) {
    set({ status: "on", error: message(err) });
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
