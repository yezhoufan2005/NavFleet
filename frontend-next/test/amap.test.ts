import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The AMap loader, and one defect in particular: a promise that could never settle.
 *
 * `import.meta.env` is read at module scope, so every case re-imports the module
 * with the environment it wants.
 */
type AmapModule = typeof import("@/lib/amap");

const loadModule = async (
  env: { key?: string; code?: string } = { key: "test-key", code: "test-code" },
): Promise<AmapModule> => {
  vi.resetModules();
  vi.stubEnv("VITE_AMAP_KEY", env.key ?? "");
  vi.stubEnv("VITE_AMAP_SECURITY_JS_CODE", env.code ?? "");
  return import("@/lib/amap");
};

const loaderScript = (): HTMLScriptElement | null =>
  document.querySelector<HTMLScriptElement>('script[data-amap-loader="true"]');

/**
 * Resolve/reject within a window, or fail saying it never settled.
 *
 * A plain `rejects.toThrow()` would also catch the hang, but only as a test-timeout
 * five seconds later with nothing pointing at the cause. The defect this file is
 * mostly about is exactly "never settles", so it deserves to be named.
 */
const settledWithin = async <T>(
  promise: Promise<T>,
  ms = 50,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
  const TIMEOUT = Symbol("timeout");
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    new Promise<typeof TIMEOUT>((resolve) =>
      setTimeout(() => resolve(TIMEOUT), ms),
    ),
  ]);
  if (outcome === TIMEOUT) {
    throw new Error("promise never settled — the loader is hanging");
  }
  return outcome;
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

beforeEach(() => {
  loaderScript()?.remove();
  delete window.AMap;
});

afterEach(() => {
  vi.unstubAllEnvs();
  loaderScript()?.remove();
  delete window.AMap;
});

describe("configuration", () => {
  it("reports missing credentials and names the file to edit", async () => {
    // v1.0.0's message named `frontend/.env`, which is a different project from this
    // console — so following it edited a file that has no effect here.
    const amap = await loadModule({ key: "", code: "" });

    expect(amap.hasAmapConfig()).toBe(false);
    expect(amap.getAmapConfigError()).toContain("frontend-next/.env");
    expect(amap.getAmapConfigError()).toContain("VITE_AMAP_KEY");

    const outcome = await settledWithin(amap.loadAmap());
    expect(outcome.ok).toBe(false);
  });

  it("distinguishes a missing security code from a missing key", async () => {
    const amap = await loadModule({ key: "k", code: "" });
    expect(amap.getAmapConfigError()).toContain("VITE_AMAP_SECURITY_JS_CODE");
  });

  it("does not load anything when the SDK is already on the page", async () => {
    const amap = await loadModule();
    window.AMap = { Map: class {} };

    const outcome = await settledWithin(amap.loadAmap());
    expect(outcome.ok).toBe(true);
    expect(loaderScript()).toBeNull();
  });
});

describe("loading the script", () => {
  it("appends one tag carrying the key and the plugins", async () => {
    const amap = await loadModule();
    void amap.loadAmap();

    const script = loaderScript();
    expect(script?.src).toContain("key=test-key");
    expect(script?.src).toContain("AMap.Scale");
    // And nothing else. `AMap.ToolBar` was dropped in 13T-D — `GpsMap` draws its own zoom
    // controls so they follow the tokens, and a plugin nobody constructs is bytes on every
    // first load.
    expect(script?.src).not.toContain("AMap.ToolBar");
    expect(script?.dataset.amapState).toBe("loading");
  });

  it("resolves with the SDK once the script reports itself loaded", async () => {
    const amap = await loadModule();
    const pending = amap.loadAmap();

    window.AMap = { Map: class {} };
    loaderScript()?.dispatchEvent(new Event("load"));

    const outcome = await settledWithin(pending);
    expect(outcome.ok).toBe(true);
  });

  it("shares one script between concurrent callers", async () => {
    const amap = await loadModule();
    void amap.loadAmap();
    void amap.loadAmap();

    expect(
      document.querySelectorAll('script[data-amap-loader="true"]'),
    ).toHaveLength(1);
  });

  it("rejects when the script loads but leaves no AMap object", async () => {
    const amap = await loadModule();
    const pending = amap.loadAmap();

    loaderScript()?.dispatchEvent(new Event("load"));

    const outcome = await settledWithin(pending);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok)
      expect(messageOf(outcome.error)).toContain("AMap 对象不可用");
  });
});

describe("the second attempt", () => {
  it("FIXED: answers instead of hanging when the tag has already finished", async () => {
    // The defect, in two steps. Step one leaves a script tag whose `load` has fired
    // and clears the single-flight promise. Step two used to attach fresh
    // `load`/`error` listeners to that tag — events that will never fire again — so
    // the promise never settled: the GPS map sat on its loading state forever, with
    // no error and nothing to retry.
    const amap = await loadModule();
    const first = amap.loadAmap();
    loaderScript()?.dispatchEvent(new Event("load"));
    await settledWithin(first);

    expect(loaderScript()?.dataset.amapState).toBe("loaded");

    const second = await settledWithin(amap.loadAmap());
    expect(second.ok).toBe(false);
    if (!second.ok)
      expect(messageOf(second.error)).toContain("AMap 对象不可用");
  });

  it("succeeds on a retry once the SDK has appeared", async () => {
    const amap = await loadModule();
    const first = amap.loadAmap();
    loaderScript()?.dispatchEvent(new Event("load"));
    await settledWithin(first);

    window.AMap = { Map: class {} };
    const second = await settledWithin(amap.loadAmap());
    expect(second.ok).toBe(true);
  });

  it("reports a failed script immediately rather than waiting on it again", async () => {
    const amap = await loadModule();
    const first = amap.loadAmap();
    loaderScript()?.dispatchEvent(new Event("error"));
    await settledWithin(first);

    expect(loaderScript()?.dataset.amapState).toBe("error");

    const second = await settledWithin(amap.loadAmap());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(messageOf(second.error)).toContain("加载失败");
  });
});
