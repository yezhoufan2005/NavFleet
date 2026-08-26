import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { router } from "./router";
import { installGlobalErrorHandlers } from "./lib/globalErrorHandlers";
import "./assets/main.css";

// Before the app mounts, so a failure during bootstrap is already reported.
installGlobalErrorHandlers();

createApp(App).use(createPinia()).use(router).mount("#app");
