import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

/**
 * Dev-server proxy target. Overridable so a second stack (the E2E suite) can run
 * its own backend on its own port without colliding with a developer's
 * `npm run dev` session on 3000.
 */
const backendOrigin = process.env.BACKEND_ORIGIN || "http://127.0.0.1:3000";
const backendWsOrigin = backendOrigin.replace(/^http/, "ws");

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      "/api": {
        target: backendOrigin,
        changeOrigin: true,
      },
      "/ws": {
        target: backendWsOrigin,
        ws: true,
      },
      "/health": {
        target: backendOrigin,
        changeOrigin: true,
      },
      "/scene-maps": {
        target: backendOrigin,
        changeOrigin: true,
      },
    },
  },
});
