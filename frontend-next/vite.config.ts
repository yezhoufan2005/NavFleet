import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

/**
 * Dev server for the v3 console.
 *
 * Port 7070 (set in package.json's `dev` script), deliberately apart from the 5173 the
 * v1.0.0 frontend uses and the 5299/5298 the e2e harness drives: nothing collides when
 * several of them run side by side. The proxy targets are the same backend, so
 * `scripts/dev.sh` can keep pointing one backend at both consoles.
 *
 * `base` is left at "/" and the router uses web history (an 11C decision), so the
 * image needs an SPA fallback — see frontend-next/nginx.conf.
 */
const backendOrigin = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:3000";
const backendWsOrigin = backendOrigin.replace(/^http/, "ws");

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": { target: backendOrigin, changeOrigin: true },
      "/ws": { target: backendWsOrigin, ws: true, changeOrigin: true },
      "/health": { target: backendOrigin, changeOrigin: true },
      "/scene-maps": { target: backendOrigin, changeOrigin: true },
    },
  },
});
