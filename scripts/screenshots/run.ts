// `pnpm screenshots`: renders the dashboard with fictional data and saves light and dark
// screenshots to docs/screenshots/. Nothing here touches your GitHub account or .dev.vars.

import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";

import { chromium } from "playwright";

import { startMockGitHub } from "./mock-github.ts";

const MOCK_PORT = 4010;
const APP = "http://127.0.0.1:5199";
const OUT = "docs/screenshots";

async function waitForApp(timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${APP}/api/session`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`App didn't start on ${APP}`);
}

await rm(".wrangler/screenshots", { recursive: true, force: true }); // fresh Durable Object state every run
await mkdir(OUT, { recursive: true });

const mock = await startMockGitHub(MOCK_PORT);
// 127.0.0.1, not localhost: Vite may otherwise listen on IPv6 only, which Node's fetch can't reach.
const vite = spawn("pnpm", ["exec", "vite", "--config", "scripts/screenshots/vite.config.ts", "--host", "127.0.0.1", "--port", "5199", "--strictPort"], {
  stdio: ["ignore", "ignore", "inherit"],
  detached: true,
});
const stop = () => {
  try {
    process.kill(-vite.pid!, "SIGTERM");
  } catch {
    // already gone
  }
  mock.close();
};
process.on("SIGINT", () => (stop(), process.exit(130)));

let browser;
try {
  await waitForApp();
  browser = await chromium.launch().catch((err: Error) => {
    throw new Error(`${err.message}\n\nInstall the browser with: pnpm exec playwright install chromium`);
  });

  for (const theme of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: "reduce" });
    await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
    await page.goto(APP);
    await page.getByText("@demo").waitFor();
    await page.locator("#security li a").first().waitFor({ timeout: 60_000 }); // real alert rows, once the Hub's background scan lands
    await page.getByRole("status").filter({ hasText: "Live" }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${OUT}/dashboard-${theme}.png` });
    console.log(`saved ${OUT}/dashboard-${theme}.png`);
    await page.close();
  }
} finally {
  await browser?.close();
  stop();
}
