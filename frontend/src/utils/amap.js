let amapPromise = null;

const AMAP_KEY = import.meta.env.VITE_AMAP_KEY?.trim();
const AMAP_SECURITY_JS_CODE = import.meta.env.VITE_AMAP_SECURITY_JS_CODE?.trim();
const AMAP_PLUGIN_LIST = ["AMap.Scale", "AMap.ToolBar"];

export function hasAmapConfig() {
  return Boolean(AMAP_KEY && AMAP_SECURITY_JS_CODE);
}

export function getAmapConfigError() {
  if (!AMAP_KEY) {
    return "未配置高德地图 Key，请在 frontend/.env 中填写 VITE_AMAP_KEY。";
  }
  if (!AMAP_SECURITY_JS_CODE) {
    return "未配置高德安全密钥，请在 frontend/.env 中填写 VITE_AMAP_SECURITY_JS_CODE。";
  }
  return "";
}

export function loadAmap() {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("当前环境不支持浏览器地图加载。"));
  }

  if (window.AMap) {
    return Promise.resolve(window.AMap);
  }

  if (!hasAmapConfig()) {
    return Promise.reject(new Error(getAmapConfigError()));
  }

  if (amapPromise) {
    return amapPromise;
  }

  window._AMapSecurityConfig = {
    securityJsCode: AMAP_SECURITY_JS_CODE,
  };

  amapPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector('script[data-amap-loader="true"]');
    if (existingScript) {
      existingScript.addEventListener("load", () => {
        if (window.AMap) {
          resolve(window.AMap);
          return;
        }
        reject(new Error("高德地图脚本已加载，但 AMap 对象不可用。"));
      });
      existingScript.addEventListener("error", () => {
        reject(new Error("高德地图脚本加载失败。"));
      });
      return;
    }

    const script = document.createElement("script");
    script.dataset.amapLoader = "true";
    script.async = true;
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(AMAP_KEY)}&plugin=${encodeURIComponent(
      AMAP_PLUGIN_LIST.join(",")
    )}`;

    script.onload = () => {
      if (window.AMap) {
        resolve(window.AMap);
        return;
      }
      reject(new Error("高德地图脚本已加载，但 AMap 对象不可用。"));
    };

    script.onerror = () => {
      reject(new Error("高德地图脚本加载失败，请检查网络或 Key 配置。"));
    };

    document.head.appendChild(script);
  }).catch((error) => {
    amapPromise = null;
    throw error;
  });

  return amapPromise;
}
