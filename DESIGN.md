---
name: github-triage
description: One pane for your pull requests, issues and security alerts, updated as it happens.
colors:
  ground: "#2e3440"
  elevated: "#3b4252"
  highlight: "#434c5e"
  hairline: "#4c566a"
  fg: "#eceff4"
  fg-muted: "#d8dee9"
  fg-subtle: "#b2bccd"
  signal: "#8fc4d3"
  success: "#a3be8c"
  warning: "#ebcb8b"
  danger: "#bf616a"
  mark: "#f5d90a"
  cat-teal: "#4eb9ad"
  cat-blue: "#7bd2f3"
  cat-indigo: "#86a4e4"
  cat-violet: "#d1b6f3"
  cat-rose: "#d28bb3"
typography:
  body:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  headline:
    fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 600
    letterSpacing: "-0.02em"
  label:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
    letterSpacing: "0.05em"
  numeric:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontWeight: 700
rounded:
  sm: "5px"
  md: "8px"
  lg: "10px"
---

# Design System: github-triage

Inherits the personal brand (personal-context `design/brand.md`, tokens v2). This file records only what this project chooses; brand rules are not repeated here.

## Choices

- **Register:** Instrument (tool: tonal ladder, hairlines, mark shown once)
- **Grounds:** Nord (dark), Snow Storm (light). Snow Storm is Nord's own light palette, proposed as a fourth brand ground (see below); Noctis Lux's paper tone didn't suit a dashboard you look at all day.
- **Signal:** the ground's own accent (default)
- **Categories:** the brand's five (`--cat-1` to `--cat-5`, then `--cat-other`), in order
- **Mark:** none. The app carries its own name and shield, so there is no wordmark dot, and selection uses the ground's `--selection` tint instead of lemon.

## Creative North Star

A departures board for your GitHub work: one glance says what is blocking you, ranked, and everything else waits its turn quietly. It refuses to be a feed, and it never shows an empty panel as an all-clear when it couldn't check.

## Project-specific rules

- **Status has four warm tones.** Between danger and warning there is `--orange` for "someone is waiting on you" (review requests, changes requested, conflicts, high alerts, 14+ days stale), at OKLCH hue 62: Nord `#fb9f41` / text `#fbab60`, Snow Storm `#c46016` / text `#9b4b11` (hue 50; warning moves to hue 92, `#9e821b` / text `#755f11`, so orange and warning stay apart). Nord's aurora orange (`#d08770`, hue 38) was too close to Nord's pink danger text to tell "critical" from "waiting on you", so it isn't used.
- **Text-safe status variants.** Status colours appear as text (pills, the "Waiting on you" counts, diff stats), so `--orange-text`, `--warning-text` and `--success-text` exist beside the brand's `dangerText`, each clearing 4.5:1 on `bg`, `bgElevated` and `bgHighlight`. `brand.py css` doesn't emit them yet, so `globals.css` sets them; they are part of the proposed brand update.
- **Snow Storm's danger is crimson** (`#d02a3a`, text `#c11830`), not a darkened Nord red: the darkened red read as dusty brown next to the orange.
- **Pills are outlined, not tinted.** Coloured text on a 10 to 15% tint of itself fell under 4.5:1 on elevated panels in both grounds.
- **Blue is only ever news.** `--info` (the row glow for "just changed on GitHub") maps to `--accent-text`; no status uses a cool hue.
- **Secondary text is `--fg-subtle`, not `--fg-muted`.** Every row has a meta line, and `fg-muted` sits too close to `fg` on both grounds to read as a second tier.
- **Theme switching** goes through next-themes with `attribute="data-ground"` (light maps to `noctis-lux`, dark to `nord`), so the brand's ground selectors drive everything; the `dark:` variant targets `[data-ground="nord"]`.
- **Density:** 14px UI text, compact two-line rows. The one motion moment is the refresh animation, off under reduced motion.
- GitHub label colours in row meta are GitHub's data, not categories.

## Pending brand update

`src/styles/brand.css` is generated from a draft of `design/brand.md` that adds the Snow Storm ground and the orange/text-safe status tokens. Once that lands in personal-context, `brand.py css brand.md --grounds nord,snow-storm` regenerates the same file, and the status block in `globals.css` can go once `brand.py` emits those tokens.
