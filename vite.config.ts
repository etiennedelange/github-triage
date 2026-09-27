import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// One Vite build for both halves: the React SPA (client) and the Hono Worker (via the
// Cloudflare plugin, which also runs the Worker and Durable Object in workerd during `vite dev`).
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
