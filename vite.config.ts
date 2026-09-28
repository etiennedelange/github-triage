import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// One Vite build for both halves: the React SPA (client) and the Hono Worker (via the
// Cloudflare plugin, which also runs the Worker and Durable Object in workerd during `vite dev`).
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  // One ID per build, baked into both halves: a tab whose ID differs from the Worker's is out of date.
  // Kept in the environment because this config is evaluated once per build (client, then Worker).
  define: { __BUILD_ID__: JSON.stringify((process.env.BUILD_ID ??= Date.now().toString(36))) },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
