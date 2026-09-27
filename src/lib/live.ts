// Overlay live updates on the server-rendered snapshot. Pure, so it's shared by the
// browser store and the tests. The snapshot stays the source of truth: a patch only
// applies if it's newer than the snapshot it would modify.

import type { InboxSection, Issue, PullRequest, SecurityAlert } from "./triage";

export type ItemPatch = { at: number; item: PullRequest | Issue | null; sections: InboxSection[] };
export type AlertPatch = { at: number; alert: SecurityAlert | null };

export type Overlaid<T> = {
  items: T[];
  /** Net change in size, to adjust GitHub's exact totals. */
  delta: number;
  /** URL → patch time for rows that arrived or changed; the time keys the row so its flash replays. */
  live: Map<string, number>;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function overlayItems<T extends PullRequest | Issue>(
  section: InboxSection,
  server: T[],
  patches: ReadonlyMap<string, ItemPatch>,
  snapshotAt: number,
): Overlaid<T> {
  const live = new Map<string, number>();
  const fresh = (p: ItemPatch | undefined): p is ItemPatch => !!p && p.at > snapshotAt;
  const belongs = (p: ItemPatch) => p.item !== null && p.sections.includes(section);
  let delta = 0;

  const items: T[] = [];
  const seen = new Set<string>();
  for (const s of server) {
    seen.add(s.url);
    const p = patches.get(s.url);
    if (!fresh(p)) items.push(s);
    else if (belongs(p)) {
      items.push(p.item as T);
      if (!same(p.item, s)) live.set(s.url, p.at);
    } else delta--;
  }
  for (const [url, p] of patches) {
    if (seen.has(url) || !fresh(p) || !belongs(p)) continue;
    items.unshift(p.item as T);
    live.set(url, p.at);
    delta++;
  }
  // Same order as the search (sort:updated-desc); callers re-sort where they sort differently.
  if (live.size || delta) items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { items, delta, live };
}

export function overlayAlerts(
  server: SecurityAlert[],
  patches: ReadonlyMap<string, AlertPatch>,
  snapshotAt: number,
): Overlaid<SecurityAlert> {
  const live = new Map<string, number>();
  let delta = 0;
  const items: SecurityAlert[] = [];
  const seen = new Set<string>();
  for (const s of server) {
    seen.add(s.url);
    const p = patches.get(s.url);
    if (!p || p.at <= snapshotAt) items.push(s);
    else if (p.alert) {
      items.push(p.alert);
      if (!same(p.alert, s)) live.set(s.url, p.at);
    } else delta--;
  }
  for (const [url, p] of patches) {
    if (seen.has(url) || p.at <= snapshotAt || !p.alert) continue;
    items.push(p.alert);
    live.set(url, p.at);
    delta++;
  }
  return { items, delta, live };
}
