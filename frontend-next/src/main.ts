import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import { installGlobalErrorHandlers } from "./lib/globalErrorHandlers";
import "./styles/index.css";

/**
 * Error handlers before `mount`, deliberately: a failure during bootstrap is
 * exactly the kind that leaves a blank page with an explanation only in the
 * console. Installed first, it raises a toast instead.
 *
 * Pinia is registered before the router. That ordering does not matter today —
 * `useAuth` is a plain reactive singleton precisely so the router's import-time
 * guard needs no store — but it is the safe order if that ever changes.
 */
installGlobalErrorHandlers();

createApp(App).use(createPinia()).use(router).mount("#app");
