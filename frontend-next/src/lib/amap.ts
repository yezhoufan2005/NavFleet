/**
 * Loads the AMap (高德地图) SDK on demand, once per page.
 *
 * The GPS map needs a third-party script that cannot be bundled, so this is a
 * promise-returning loader with the usual single-flight guard. Two things about it
 * are worth reading before changing:
 *
 * **The script's own state is tracked, not inferred from events.** v1.0.0 handled
 * "a loader tag already exists" by attaching `load`/`error` listeners to it — which
 * works only if the script has not finished yet. If it *had* finished, neither event
 * would ever fire again and the returned promise never settled: the GPS map sat on
 * its loading state forever, with no error and nothing to retry. That is reachable
 * in one step: a first attempt whose script loads but leaves `window.AMap` absent
 * rejects and clears the single-flight promise, so the next call takes exactly that
 * branch. A `data-amap-state` attribute makes the already-finished case answerable
 * instead of unobservable.
 *
 * **A failed load clears the guard, a successful one does not.** Retrying after a
 * network failure has to be possible; re-adding the tag after success would not be.
 */

declare global {
  interface Window {
    AMap?: unknown;
    _AMapSecurityConfig?: { securityJsCode: string };
  }
}

type LoaderState = "loading" | "loaded" | "error";

const LOADER_SELECTOR = 'script[data-amap-loader="true"]';
const AMAP_PLUGIN_LIST = ["AMap.Scale", "AMap.ToolBar"];

const AMAP_KEY = import.meta.env.VITE_AMAP_KEY?.trim();
const AMAP_SECURITY_JS_CODE =
  import.meta.env.VITE_AMAP_SECURITY_JS_CODE?.trim();

let amapPromise: Promise<unknown> | null = null;

export const hasAmapConfig = (): boolean =>
  Boolean(AMAP_KEY && AMAP_SECURITY_JS_CODE);

export const getAmapConfigError = (): string => {
  // Naming the file that actually needs editing, and `.env.example` beside it —
  // v1.0.0 pointed at `frontend/.env`, which is the wrong project for this console.
  if (!AMAP_KEY) {
    return "未配置高德地图 Key，请在 frontend-next/.env 中填写 VITE_AMAP_KEY（见 .env.example）。";
  }
  if (!AMAP_SECURITY_JS_CODE) {
    return "未配置高德安全密钥，请在 frontend-next/.env 中填写 VITE_AMAP_SECURITY_JS_CODE（见 .env.example）。";
  }
  return "";
};

const NO_AMAP_OBJECT = "高德地图脚本已加载，但 AMap 对象不可用。";

const settleFromWindow = (
  resolve: (value: unknown) => void,
  reject: (reason: Error) => void,
): void => {
  if (window.AMap) {
    resolve(window.AMap);
    return;
  }
  reject(new Error(NO_AMAP_OBJECT));
};

const awaitExistingScript = (script: Element): Promise<unknown> =>
  new Promise<unknown>((resolve, reject) => {
    const state = (script as HTMLScriptElement).dataset.amapState as
      LoaderState | undefined;

    // Already finished: its events will never fire again, so answer from the state
    // it recorded. This is the branch whose absence made the loader hang.
    if (state === "loaded") {
      settleFromWindow(resolve, reject);
      return;
    }
    if (state === "error") {
      reject(new Error("高德地图脚本加载失败。"));
      return;
    }

    script.addEventListener("load", () => settleFromWindow(resolve, reject));
    script.addEventListener("error", () =>
      reject(new Error("高德地图脚本加载失败。")),
    );
  });

export const loadAmap = (): Promise<unknown> => {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("当前环境不支持浏览器地图加载。"));
  }

  if (window.AMap) return Promise.resolve(window.AMap);
  if (!hasAmapConfig()) return Promise.reject(new Error(getAmapConfigError()));
  if (amapPromise) return amapPromise;

  window._AMapSecurityConfig = {
    securityJsCode: AMAP_SECURITY_JS_CODE as string,
  };

  const existing = document.querySelector(LOADER_SELECTOR);
  const attempt = existing
    ? awaitExistingScript(existing)
    : new Promise<unknown>((resolve, reject) => {
        const script = document.createElement("script");
        script.dataset.amapLoader = "true";
        script.dataset.amapState = "loading";
        script.async = true;
        script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(
          AMAP_KEY as string,
        )}&plugin=${encodeURIComponent(AMAP_PLUGIN_LIST.join(","))}`;

        script.onload = () => {
          script.dataset.amapState = "loaded";
          settleFromWindow(resolve, reject);
        };
        script.onerror = () => {
          script.dataset.amapState = "error";
          reject(new Error("高德地图脚本加载失败，请检查网络或 Key 配置。"));
        };

        document.head.appendChild(script);
      });

  amapPromise = attempt.catch((error: unknown) => {
    // Cleared so a retry is possible; the tag stays, and its recorded state is what
    // keeps the retry from waiting on an event that has already fired.
    amapPromise = null;
    throw error;
  });

  return amapPromise;
};

/** Test-only: forget the single-flight promise. */
export const __resetAmapLoader = (): void => {
  amapPromise = null;
};
