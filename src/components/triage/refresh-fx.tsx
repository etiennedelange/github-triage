"use client";

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

import { refresh } from "@/app/actions";

/*
 * Refresh animations. A refresh moves through phases:
 *   idle → pending (server action in flight; loops) → landing (fresh data committed; one-shot) → idle
 * The phase and chosen effect are exposed as data attributes on a wrapper so CSS in
 * globals.css can drive per-panel/per-row keyframes without making server rows client
 * components. Overlays and numbers use Motion. Everything is transform/opacity or an
 * overlay, so there's no layout shift, and it all switches off under reduced motion.
 */

export const EFFECTS = ["radar", "cascade", "decrypt"] as const;
export type Effect = (typeof EFFECTS)[number];
type Phase = "idle" | "pending" | "landing";

/** How long each one-shot landing runs, including its longest stagger delay. */
const LANDING_MS: Record<Effect, number> = { radar: 1800, cascade: 1400, decrypt: 1400 };

type Ctx = { fx: Effect | null; phase: Phase; landing: number; pending: boolean; run: (origin: HTMLElement) => void };
const FxContext = createContext<Ctx>({ fx: null, phase: "idle", landing: 0, pending: false, run: () => {} });
export const useRefreshFx = () => use(FxContext);

// ---------- Effect choice (per-viewer convenience, so localStorage) ----------

const STORAGE_KEY = "triage-refresh-fx";
const listeners = new Set<() => void>();

function readEffect(): Effect {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return EFFECTS.includes(v as Effect) ? (v as Effect) : "radar";
  } catch {
    return "radar";
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
    () => "radar",
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

// ---------- Provider ----------

export function RefreshFx({ children }: { children: ReactNode }) {
  const chosen = useEffectChoice();
  const reduced = usePrefersReducedMotion();
  const fx = reduced ? null : chosen;

  const [pending, start] = useTransition();
  const [landing, setLanding] = useState(0);
  const [settled, setSettled] = useState(0);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const root = useRef<HTMLDivElement>(null);

  const phase: Phase = pending ? "pending" : landing !== settled ? "landing" : "idle";

  const run = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setOrigin({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    root.current?.querySelectorAll<HTMLElement>("[data-fx-panel]").forEach((p, i) => p.style.setProperty("--fx-i", `${i}`));
    start(async () => {
      await refresh();
      // Commits with the fresh data, so the landing starts exactly as it appears.
      startTransition(() => setLanding((n) => n + 1));
    });
  };

  // Stagger targets before the landing frame paints: delay depends on the effect's geometry.
  useLayoutEffect(() => {
    if (!landing || !fx || !root.current) return;
    const { x, y } = origin;
    const vh = window.innerHeight;
    const maxDist = Math.hypot(window.innerWidth, vh);
    root.current.querySelectorAll<HTMLElement>("[data-fx-panel]").forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const delay =
        fx === "radar"
          ? (Math.hypot(r.left + r.width / 2 - x, r.top + r.height / 2 - y) / maxDist) * 900 // wavefront arrival
          : fx === "decrypt"
            ? Math.min(Math.max(r.top / vh, 0), 1) * 550 // when the final scanline crosses it
            : i * 35; // cascade: dealt in reading order
      el.style.setProperty("--fx-d", `${Math.round(delay)}ms`);
      el.querySelectorAll<HTMLElement>("li").forEach((li, j) => li.style.setProperty("--fx-r", `${Math.min(j, 10) * 28}ms`));
    });
  }, [landing, fx, origin]);

  useEffect(() => {
    if (!landing) return;
    const t = setTimeout(() => setSettled(landing), fx ? LANDING_MS[fx] : 0);
    return () => clearTimeout(t);
  }, [landing, fx]);

  return (
    <FxContext value={{ fx, phase, landing, pending, run }}>
      <div ref={root} data-fx={fx ?? "none"} data-phase={phase}>
        {children}
        {fx === "radar" && <RadarOverlay phase={phase} landing={landing} origin={origin} />}
        {fx === "decrypt" && <ScanlineOverlay phase={phase} landing={landing} />}
      </div>
    </FxContext>
  );
}

// ---------- Overlays ----------

const overlay = "pointer-events-none fixed inset-0 z-50 overflow-hidden";

function RadarOverlay({ phase, landing, origin }: { phase: Phase; landing: number; origin: { x: number; y: number } }) {
  // Only rendered client-side (overlays never show during SSR), so window is safe here.
  const reach = typeof window === "undefined" ? 0 : Math.hypot(window.innerWidth, window.innerHeight) * 2.1;
  return (
    <div aria-hidden className={overlay}>
      <AnimatePresence>
        {phase === "pending" && (
          <motion.div
            key="sweep"
            className="fx-radar-field"
            // Scope centred on the page so the sweep crosses every panel; the landing wave comes from the button.
            style={{ left: "50%", top: "55%" }}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.35 } }}
            transition={{ duration: 0.4, ease: "easeOut" }}
          >
            <div className="fx-radar-rings" />
            <div className="fx-radar-beam" />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {phase === "landing" &&
          [0, 0.12].map((delay, i) => (
            <motion.div
              key={`${landing}-${i}`}
              className={i === 0 ? "fx-shockwave" : "fx-shockwave fx-shockwave-soft"}
              style={{ left: origin.x, top: origin.y }}
              initial={{ width: 0, height: 0, opacity: i === 0 ? 0.9 : 0.5 }}
              animate={{ width: reach, height: reach, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 1.1, delay, ease: [0.16, 0.84, 0.3, 1] }}
            />
          ))}
      </AnimatePresence>
    </div>
  );
}

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
    const scramble = (resolved: number) =>
      (el.textContent = [...text].map((c, i) => (i < resolved || c === " " ? c : glyph())).join(""));

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

/** A count that lands with the chosen effect: counts up (radar), rolls (cascade) or decodes (decrypt). */
export function FxNumber({ value }: { value: number | string }) {
  const { fx, phase, landing } = useRefreshFx();
  const ref = useRef<HTMLSpanElement>(null);
  const text = String(value);
  const numeric = typeof value === "number";

  useEffect(() => {
    const el = ref.current;
    if (!el || fx !== "radar" || phase !== "landing" || !numeric) return;
    const controls = animate(0, value, {
      delay: (panelDelay(el) + 100) / 1000,
      duration: 0.7,
      ease: [0.2, 0.8, 0.2, 1],
      onUpdate: (v) => (el.textContent = String(Math.round(v))),
      onComplete: () => (el.textContent = text),
    });
    return () => controls.stop();
  }, [fx, phase, landing, value, numeric, text]);

  if (fx === "decrypt") return <FxText text={text} />;
  if (fx === "cascade" && phase === "landing" && numeric) return <Odometer key={landing} text={text} />;
  return (
    <span ref={ref} className="tabular-nums">
      {text}
    </span>
  );
}

function Odometer({ text }: { text: string }) {
  return (
    <span className="inline-flex tabular-nums" aria-label={text}>
      {[...text].map((d, i) => (
        <span key={i} aria-hidden className="fx-odo-col">
          <span className="fx-odo-reel" style={{ "--to": `-${(10 + Number(d)) * 5}%`, "--i": i } as CSSProperties}>
            {Array.from({ length: 20 }, (_, n) => (
              <span key={n}>{n % 10}</span>
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}
