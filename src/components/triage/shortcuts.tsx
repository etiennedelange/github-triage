import { Keyboard, X } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

import { navigate } from "@/client/url";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useRefreshFx } from "./refresh-fx";
import { TONE, type Tone } from "./rows";

/*
 * Keyboard shortcuts. Single keys, so they can be switched off (WCAG 2.1.4); Cmd/Ctrl+Shift+D
 * for the theme always works. None fire while you're typing or inside a popover or dialog.
 */

// ---------- On/off (per-viewer convenience, so localStorage) ----------

const STORAGE_KEY = "triage-shortcuts";
const listeners = new Set<() => void>();

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function setEnabled(on: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // private mode etc.; the choice just won't persist
  }
  listeners.forEach((l) => l());
}

function useEnabled(): boolean {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    readEnabled,
    () => true,
  );
}

// ---------- Moving around ----------

const rowLinks = () => [...document.querySelectorAll<HTMLAnchorElement>("[data-row-link]")];
const panels = () => [...document.querySelectorAll<HTMLElement>("#panels section[id]")];

function focusRow(delta: 1 | -1) {
  const rows = rowLinks();
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement as HTMLAnchorElement);
  // Nothing focused yet: j starts at the top, k at the bottom.
  const next = at === -1 ? (delta === 1 ? 0 : rows.length - 1) : Math.min(Math.max(at + delta, 0), rows.length - 1);
  rows[next].focus();
  rows[next].scrollIntoView({ block: "nearest" });
}

/** The nth panel's first row, or the panel itself when it's empty. */
function focusPanel(n: number) {
  const panel = panels()[n];
  if (!panel) return;
  const target = panel.querySelector<HTMLElement>("[data-row-link]") ?? panel;
  if (target === panel) panel.tabIndex = -1;
  target.focus({ preventScroll: true });
  panel.scrollIntoView({ block: "start" });
}

function focusRepoFilter() {
  const nav = document.querySelector<HTMLElement>('nav[aria-label="Filter by repository"]');
  nav?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
}

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable ||
    !!el.closest("[role=dialog], dialog"));

// ---------- Keys ----------

export function Shortcuts() {
  const enabled = useEnabled();
  const { resolvedTheme, setTheme } = useTheme();
  const { run: refresh, pending } = useRefreshFx();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const toggleTheme = () => setTheme(resolvedTheme === "dark" ? "light" : "dark");
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e.target)) return;
      const key = e.key.toLowerCase();
      // The one shortcut with a modifier: always on.
      if (key === "d" && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
        e.preventDefault();
        return toggleTheme();
      }
      if (!enabled || e.metaKey || e.ctrlKey || e.altKey) return;

      const actions: Record<string, () => void> = {
        j: () => focusRow(1),
        k: () => focusRow(-1),
        o: () => (document.activeElement as HTMLElement | null)?.closest("li")?.querySelector<HTMLElement>("[data-row-link]")?.click(),
        r: () => !pending && refresh(),
        "/": focusRepoFilter,
        d: toggleTheme,
        "?": () => dialog.current?.showModal(),
        escape: () => new URLSearchParams(location.search).has("repo") && navigate("/"),
      };
      const action = /^[1-8]$/.test(key) ? () => focusPanel(Number(key) - 1) : actions[key];
      if (!action) return;
      e.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, resolvedTheme, setTheme, refresh, pending]);

  return <ShortcutsDialog ref={dialog} enabled={enabled} />;
}

/** Opens the help dialog: the status-bar link, for anyone who doesn't know about `?`. */
export function openShortcuts() {
  document.querySelector<HTMLDialogElement>("dialog#shortcuts")?.showModal();
}

// ---------- Help ----------

const KEYS: [keys: string[], what: string][] = [
  [["j"], "Next row"],
  [["k"], "Previous row"],
  [["o"], "Open the focused row on GitHub"],
  [["1", "–", "8"], "Jump to a panel"],
  [["/"], "Filter by repository"],
  [["Esc"], "Clear the repository filter"],
  [["r"], "Refresh from GitHub"],
  [["d"], "Dark / light theme"],
  [["?"], "This help"],
];

const LEGEND: [tone: Tone, label: string, meaning: string][] = [
  ["danger", "Red", "Failing checks, critical alerts"],
  ["orange", "Orange", "Someone is waiting on you: review requests, changes requested, conflicts, high alerts, 14+ days stale"],
  ["warning", "Amber", "In progress: checks running, Claude working, medium alerts, branches with no PR"],
  ["success", "Green", "Clear to go: checks passing, approved, ready to merge"],
  ["muted", "Grey", "For information: low alerts, drafts, awaiting review"],
];

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border bg-muted px-1 font-mono text-[11px] text-foreground">
      {children}
    </kbd>
  );
}

function ShortcutsDialog({ ref, enabled }: { ref: React.Ref<HTMLDialogElement>; enabled: boolean }) {
  return (
    <dialog
      ref={ref}
      id="shortcuts"
      aria-labelledby="shortcuts-title"
      // Click on the backdrop (the dialog element itself, outside its content) closes it.
      onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}
      className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-xl border bg-popover p-0 text-sm text-popover-foreground shadow-[0_12px_40px_-12px_rgb(0_0_0/0.35)] backdrop:bg-black/40"
    >
      <div className="max-h-[calc(100dvh-4rem)] space-y-4 overflow-y-auto p-4">
        <header className="flex items-center gap-2">
          <Keyboard aria-hidden className="size-4 text-muted-foreground" />
          <h2 id="shortcuts-title" className="font-semibold">
            Shortcuts and colours
          </h2>
          <form method="dialog" className="ml-auto">
            <Button variant="ghost" size="icon-sm" aria-label="Close">
              <X />
            </Button>
          </form>
        </header>

        <section aria-label="Keyboard shortcuts" className="space-y-2">
          <dl className={cn("grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5", !enabled && "opacity-50")}>
            {KEYS.map(([keys, what]) => (
              <div key={what} className="contents">
                <dt className="flex items-center gap-1">
                  {keys.map((k) => (k === "–" ? <span key={k}>–</span> : <Kbd key={k}>{k}</Kbd>))}
                </dt>
                <dd className="text-muted-foreground">{what}</dd>
              </div>
            ))}
          </dl>
          <label className="flex items-center gap-2 pt-1">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="size-4 accent-foreground" />
            Single-key shortcuts
          </label>
          <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            Either way, <Kbd>⌘/Ctrl</Kbd>
            <Kbd>⇧</Kbd>
            <Kbd>D</Kbd> switches the theme.
          </p>
        </section>

        <section aria-labelledby="legend-title" className="space-y-2 border-t pt-4">
          <h3 id="legend-title" className="font-medium">
            What the colours mean
          </h3>
          <ul className="space-y-1.5">
            {LEGEND.map(([tone, label, meaning]) => (
              <li key={tone} className="flex items-start gap-2">
                <span
                  className={cn("inline-flex h-5 w-14 shrink-0 items-center justify-center rounded-md text-[11px] font-medium", TONE[tone])}
                >
                  {label}
                </span>
                <span className="text-muted-foreground">{meaning}</span>
              </li>
            ))}
            <li className="flex items-start gap-2">
              <span className="inline-flex h-5 w-14 shrink-0 items-center justify-center rounded-md border border-info/45 text-[11px] font-medium text-info">
                Glow
              </span>
              <span className="text-muted-foreground">A row that just changed on GitHub. Blue is only ever news.</span>
            </li>
          </ul>
        </section>

        <section aria-labelledby="live-title" className="space-y-1 border-t pt-4">
          <h3 id="live-title" className="font-medium">
            How current it is
          </h3>
          <p className="text-muted-foreground">
            Repos with the GitHub App installed update within seconds. Others are checked every 2 minutes while a tab is open. Checks on PRs
            from forks, and older commit statuses, update on the next Refresh. Security alerts come from a scan that reruns once it's 15
            minutes old.
          </p>
        </section>
      </div>
    </dialog>
  );
}
