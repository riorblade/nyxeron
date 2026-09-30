import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev mirrors production's edge proxy (deploy/Caddyfile): /api → the api service, /ws → the multiplayer relay.
// Run them with `pnpm dev:api` and `pnpm dev:relay`; without them the game falls back to offline prices and
// single player.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8788",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});
