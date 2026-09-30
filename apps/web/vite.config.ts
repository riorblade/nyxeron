import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { getQuotes } from "./server/quotes";

/** GET /api/quotes: Binance RWA spot prices, signed server-side (keys from .env.local, never sent to the browser). */
function quotesApi(env: Record<string, string>): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.split("?")[0] !== "/api/quotes") return next();
    getQuotes({
      key: env.BINANCE_WEB3_API_KEY,
      secret: env.BINANCE_WEB3_SECRET_KEY,
    }).then((q) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(q));
    }, next);
  };
  return {
    name: "nyxeron-quotes",
    configureServer: (s) => void s.middlewares.use(handler),
    configurePreviewServer: (s) => void s.middlewares.use(handler),
  };
}

export default defineConfig(({ mode }) => ({
  // "" prefix: server-only vars too. Only VITE_* ever reach client code.
  plugins: [
    react(),
    tailwindcss(),
    quotesApi(loadEnv(mode, process.cwd(), "")),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
}));
