import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The API runs as a separate process in dev; Vite proxies /api to it so the
// browser always talks to a SINGLE origin — same as production, where Fastify
// serves this built SPA itself. That's why VITE_API_URL_LOYALTY_APP stays EMPTY everywhere.
const API_TARGET = process.env.API_TARGET ?? "http://127.0.0.1:4001";

export default defineConfig({
  base: "/loyalty-app/",
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    host: true, // bind 0.0.0.0 — required on Replit / remote dev
    port: 5173,
    strictPort: true,
    allowedHosts: true, // Replit serves dev through its own proxy hostname
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/webhooks": { target: API_TARGET, changeOrigin: true },
    },
  },
});
