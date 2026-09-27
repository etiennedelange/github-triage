import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Same app as vite.config.ts, but with the screenshot Worker config and throwaway state.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({ configPath: "scripts/screenshots/wrangler.jsonc", persistState: { path: ".wrangler/screenshots" } }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
});
