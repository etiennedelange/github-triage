import { AnimatePresence, animate, motion } from "motion/react";
import {
  createContext,
  startTransition,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type CSSProperties,
  type ReactNode,
} from "react";

import { refreshAll } from "@/client/api";

/*
 * Refresh animations. A refresh moves through phases:
 *   idle → pending (request in flight; loops) → landing (fresh data committed; one-shot) → idle
 * The phase and chosen effect are exposed as data attributes on a wrapper so CSS in
 * globals.css can drive per-panel/per-row keyframes. Only panels whose content actually
 * changed get the landing ([data-fx-changed]): light means news, so an unchanged board stays
 * still. Everything is transform/opacity or an overlay, so there's no layout shift, and it all
 * switches off under reduced motion.
 */

export const EFFECTS = ["cascade", "decrypt"] as const;
export type Effect = (typeof EFFECTS)[number];
type Phase = "idle" | "pending" | "landing";

/** How long each one-shot landing runs, including its longest stagger delay. */
const LANDING_MS: Record<Effect, number> = { cascade: 1400, decrypt: 1400 };

type Ctx = { fx: Effect | null; phase: Phase; landing: number; pending: boolean; run: () => void };
const FxContext = createContext<Ctx>({ fx: null, phase: "idle", landing: 0, pending: false, run: () => {} });
export const useRefreshFx = () => use(FxContext);

// ---------- Effect choice (per-viewer convenience, so localStorage) ----------

const STORAGE_KEY = "triage-refresh-fx";
const listeners = new Set<() => void>();

function readEffect(): Effect {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    // Anything else, including the retired "radar", falls back to the default.
    return EFFECTS.includes(v as Effect) ? (v as Effect) : "cascade";
  } catch {
    return "cascade";
  }
}

export function setEffect(fx: Effect) {
  try {
    localStorage.setItem(STORAGE_KEY, fx);
  } catch {
    // private mode etc.; the choice just won't persist
  }
  listeners.forEach((l) => l());
}

export function useEffectChoice(): Effect {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    readEffect,
    () => "cascade",
  );
}

/** Like Motion's useReducedMotion, but hydration-safe: assumes full motion on the server/first pass. */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (l) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", l);
      return () => mq.removeEventListener("change", l);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
}

// ---------- Change detection ----------

/**
 * What a panel shows, for telling whether a refresh changed it. Stat tiles declare theirs
 * (`data-fx-sig`); panels use their rows and footer, which never hold animated text.
 */
function signature(el: HTMLElement): string {
  return el.dataset.fxSig ?? [...el.querySelectorAll(":scope > ul, :scope > footer")].map((n) => n.textContent).join("\u0000");
}

const panelsIn = (root: HTMLElement | null) => [...(root?.querySelectorAll<HTMLElement>("[data-fx-panel]") ?? [])];
const keyOf = (el: HTMLElement, i: number) => el.id || el.getAttribute("href") || `#${i}`;

// ---------- Provider ----------

export function RefreshFx({ children }: { children: ReactNode }) {
  const chosen = useEffectChoice();
  const reduced = usePrefersReducedMotion();
  const fx = reduced ? null : chosen;

  const [pending, start] = useTransition();
  const [landing, setLanding] = useState(0);
  const [settled, setSettled] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const before = useRef(new Map<string, string>());

  const phase: Phase = pending ? "pending" : landing !== settled ? "landing" : "idle";

  const run = () => {
    const panels = panelsIn(root.current);
    before.current = new Map(panels.map((p, i) => [keyOf(p, i), signature(p)]));
    panels.forEach((p, i) => p.style.setProperty("--fx-i", `${i}`));
    start(async () => {
      await refreshAll().catch(() => {}); // failures show in the panels; the animation still settles
      // Commits with the fresh data, so the landing starts exactly as it appears.
      startTransition(() => setLanding((n) => n + 1));
    });
  };

  // Before the landing frame paints: mark what changed, and stagger it by the effect's geometry.
  useLayoutEffect(() => {
    if (!landing || !root.current) return;
    const vh = window.innerHeight;
    let n = 0;
    panelsIn(root.current).forEach((el, i) => {
      const changed = before.current.get(keyOf(el, i)) !== signature(el);
      el.toggleAttribute("data-fx-changed", changed);
      if (!changed || !fx) return;
      const r = el.getBoundingClientRect();
      const delay =
        fx === "decrypt"
          ? Math.min(Math.max(r.top / vh, 0), 1) * 550 // when the final scanline crosses it
          : n++ * 35; // cascade: dealt in reading order
      el.style.setProperty("--fx-d", `${Math.round(delay)}ms`);
      el.querySelectorAll<HTMLElement>("li").forEach((li, j) => li.style.setProperty("--fx-r", `${Math.min(j, 10) * 28}ms`));
    });
  }, [landing, fx]);

  useEffect(() => {
    if (!landing) return;
    const t = setTimeout(() => setSettled(landing), fx ? LANDING_MS[fx] : 0);
    return () => clearTimeout(t);
  }, [landing, fx]);

  return (
    <FxContext value={{ fx, phase, landing, pending, run }}>
      <div ref={root} data-fx={fx ?? "none"} data-phase={phase}>
        {children}
        {fx === "decrypt" && <ScanlineOverlay phase={phase} landing={landing} />}
      </div>
    </FxContext>
  );
}

// ---------- Overlays ----------

const overlay = "pointer-events-none fixed inset-0 z-50 overflow-hidden";

function ScanlineOverlay({ phase, landing }: { phase: Phase; landing: number }) {
  return (
    <div aria-hidden className={overlay}>
      <AnimatePresence>
        {phase !== "idle" && (
          <motion.div
            key="texture"
            className="fx-crt"
            initial={{ opacity: 0 }}
            animate={{ opacity: phase === "pending" ? 1 : 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: phase === "pending" ? 0.25 : 0.8 }}
          />
        )}
      </AnimatePresence>
      {phase === "pending" && (
        <motion.div
          key="loop"
          className="fx-scanline"
          initial={{ y: "-20vh" }}
          animate={{ y: "105vh" }}
          transition={{ duration: 1.25, ease: "linear", repeat: Infinity }}
        />
      )}
      {phase === "landing" && (
        <motion.div
          key={`final-${landing}`}
          className="fx-scanline fx-scanline-final"
          initial={{ y: "-20vh", opacity: 1 }}
          animate={{ y: "105vh", opacity: [1, 1, 0] }}
          transition={{ duration: 0.65, ease: [0.4, 0, 0.6, 1] }}
        />
      )}
    </div>
  );
}

// ---------- Text & numbers ----------

const GLYPHS = "01<>/\\|=+*#%$&@▓▒░";
const glyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];

/** Read the stagger delay (ms) the provider assigned to this element's panel. */
function panelDelay(el: HTMLElement | null): number {
  const host = el?.closest<HTMLElement>("[data-fx-panel]");
  return parseFloat(host?.style.getPropertyValue("--fx-d") || "0") || 0;
}

/**
 * Text that scrambles while refreshing and decodes left→right when data lands (decrypt only).
 * The real text stays in the DOM (invisible while scrambled) so size never changes and
 * screen readers always get the real value.
 */
export function FxText({ text, className }: { text: string; className?: string }) {
  const { fx, phase, landing } = useRefreshFx();
  const out = useRef<HTMLSpanElement>(null);
  const active = fx === "decrypt" && phase !== "idle";

  useEffect(() => {
    const el = out.current;
    if (!el || !active) return;
    const scramble = (resolved: number) => (el.textContent = [...text].map((c, i) => (i < resolved || c === " " ? c : glyph())).join(""));

    if (phase === "pending") {
      const id = setInterval(() => scramble(0), 55);
      return () => clearInterval(id);
    }
    const controls = animate(0, text.length, {
      delay: (panelDelay(el) + 120) / 1000,
      duration: 0.45,
      ease: "easeOut",
      onUpdate: (v) => scramble(Math.floor(v)),
      onComplete: () => (el.textContent = text),
    });
    return () => controls.stop();
  }, [active, phase, text, landing]);

  if (!active) return <span className={className}>{text}</span>;
  return (
    <span className={`relative inline-block ${className ?? ""}`}>
      <span className="invisible">{text}</span>
      <span ref={out} aria-hidden className="absolute inset-0 overflow-hidden whitespace-nowrap text-success" />
      <span className="sr-only">{text}</span>
    </span>
  );
}

/**
 * A count that lands with the chosen effect: rolls from its previous value (cascade) or
 * decodes (decrypt). An unchanged count never moves, and never passes through zero on the
 * way: a count that briefly reads 0 is a false all-clear.
 */
export function FxNumber({ value }: { value: number | string }) {
  const { fx, phase, landing } = useRefreshFx();
  const text = String(value);
  // The value on screen before this refresh; follows live updates while idle.
  const [prev, setPrev] = useState(text);
  if (phase === "idle" && prev !== text) setPrev(text);

  if (fx === "decrypt") return <FxText text={text} />;
  if (fx === "cascade" && phase === "landing" && prev !== text && /^\d+$/.test(text) && /^\d+$/.test(prev)) {
    return <Odometer key={landing} from={prev} to={text} />;
  }
  return <span className="tabular-nums">{text}</span>;
}

/** Each digit rolls forward from its old value to its new one; digits that didn't change stay put. */
function Odometer({ from, to }: { from: string; to: string }) {
  const old = from.padStart(to.length, "0").slice(-to.length);
  const offset = (d: number) => `-${d * 5}%`;
  return (
    <span className="inline-flex tabular-nums" aria-label={to}>
      {[...to].map((d, i) => {
        const a = Number(old[i]);
        const b = Number(d);
        // A 20-digit reel (0–9 twice), so every roll moves forward: from a in the first decade to b ahead of it.
        const end = b > a ? b : b + 10;
        return (
          <span key={i} aria-hidden className="fx-odo-col">
            <span className="fx-odo-reel" style={{ "--from": offset(a), "--to": offset(a === b ? a : end), "--i": i } as CSSProperties}>
              {Array.from({ length: 20 }, (_, n) => (
                <span key={n}>{n % 10}</span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
