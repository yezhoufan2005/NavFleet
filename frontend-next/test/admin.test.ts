import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import type { Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import AdminView from "@/views/AdminView.vue";
import ScenesView from "@/views/admin/ScenesView.vue";
import SystemStatusView from "@/views/admin/SystemStatusView.vue";
import {
  clearStoredState,
  readStoredState,
  VALUE_PREVIEW_LIMIT,
} from "@/lib/localState";
import { useFleetStore } from "@/stores/fleet";

/**
 * 管理 and its two built children.
 *
 * The pages exist to answer questions that every other surface answers ambiguously:
 * 系统状态 separates "I cannot reach the backend" from "the backend cannot reach the
 * broker", and 场景 separates "this scene has no backdrop configured" from "it has one
 * and the file 404s". So most of these tests are about *which* answer is given, not
 * about whether something rendered.
 */
enableAutoUnmount(afterEach);

const routerFor = (component: unknown, path: string): Router => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path, component: component as never },
      { path: "/:rest(.*)*", component: { template: "<i />" } },
    ],
  });
  return router;
};

const mountAt = async (component: unknown, path: string) => {
  const router = routerFor(component, path);
  await router.push(path);
  await router.isReady();
  const wrapper = mount(component as never, {
    global: { plugins: [router] },
  });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("本地留存清单", () => {
  it("按前缀发现，而不是照着一份写死的清单", () => {
    // The point of the prefix scan: parity §8.8 documented five keys and there are
    // nine today. A page that answers "what is this browser holding" must not be able
    // to drift from the answer.
    localStorage.setItem("navfleet:theme", "dark");
    localStorage.setItem("navfleet:brand-new-thing", "42");
    localStorage.setItem("unrelated:other-app", "nope");

    const keys = readStoredState().map((entry) => entry.key);
    expect(keys).toEqual(["navfleet:brand-new-thing", "navfleet:theme"]);
  });

  it("认识的键给中文名，不认识的就用键本身", () => {
    // The unknown case is the interesting one — it means something wrote a preference
    // nobody documented — so it is listed rather than hidden.
    localStorage.setItem("navfleet:theme", "dark");
    localStorage.setItem("navfleet:mystery", "1");

    const byKey = new Map(
      readStoredState().map((entry) => [entry.key, entry.label]),
    );
    expect(byKey.get("navfleet:theme")).toBe("主题偏好");
    expect(byKey.get("navfleet:mystery")).toBe("navfleet:mystery");
  });

  it("两种存续都扫，并标出是哪一种", () => {
    localStorage.setItem("navfleet:theme", "dark");
    sessionStorage.setItem("navfleet:ros-scene-views:v2", "{}");

    const byKey = new Map(
      readStoredState().map((entry) => [entry.key, entry.area]),
    );
    expect(byKey.get("navfleet:theme")).toBe("local");
    expect(byKey.get("navfleet:ros-scene-views:v2")).toBe("session");
  });

  it("长值截断并说明自己被截断了", () => {
    localStorage.setItem("navfleet:big", "x".repeat(VALUE_PREVIEW_LIMIT + 50));
    const [entry] = readStoredState();

    expect(entry!.value).toHaveLength(VALUE_PREVIEW_LIMIT);
    expect(entry!.truncated).toBe(true);
  });

  it("清除只删自己的键，并且一个都不漏", () => {
    // Removing while iterating by index skips entries — the reason the keys are
    // collected first. Three keys must produce three deletions, not two.
    localStorage.setItem("navfleet:a", "1");
    localStorage.setItem("navfleet:b", "2");
    localStorage.setItem("navfleet:c", "3");
    sessionStorage.setItem("navfleet:d", "4");
    localStorage.setItem("keep-me", "yes");

    expect(clearStoredState()).toBe(4);
    expect(readStoredState()).toEqual([]);
    expect(localStorage.getItem("keep-me")).toBe("yes");
  });
});

describe("系统状态", () => {
  const readyBody = (
    checks: { store?: boolean; mongo?: boolean; mqtt?: boolean },
    ready = true,
  ) =>
    new Response(
      JSON.stringify({
        ready,
        degraded: false,
        checks,
        now: "2026-08-31T00:00:00Z",
      }),
      {
        status: ready ? 200 : 503,
        headers: { "Content-Type": "application/json" },
      },
    );

  const mountStatus = (response: Response | Error) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        response instanceof Error
          ? Promise.reject(response)
          : Promise.resolve(response),
      ),
    );
    return mountAt(SystemStatusView, "/admin/system");
  };

  it("后端连不上时，那件事本身就是诊断", async () => {
    // Not "加载失败": failing to reach the backend is the answer. And the three
    // sub-checks are suppressed, because they are the backend's report about itself.
    const wrapper = await mountStatus(new TypeError("Failed to fetch"));

    expect(wrapper.text()).toContain("无法访问");
    expect(wrapper.text()).toContain("Failed to fetch");
    expect(wrapper.text()).not.toContain("MQTT broker");
  });

  it("503 是一个答案，不是一个错误", async () => {
    // The endpoint returns 503 while the store initialises. Treating that as a failed
    // request would hide the one state it exists to report.
    const wrapper = await mountStatus(
      readyBody({ store: false, mongo: true, mqtt: true }, false),
    );

    expect(wrapper.text()).toContain("初始化中");
    expect(wrapper.text()).toContain("可访问");
  });

  it("Mongo 掉线报成降级而不是故障，并说清丢的是什么", async () => {
    // The store keeps serving without Mongo, so calling it critical would cry wolf —
    // what is actually lost is history, and the page says so.
    const wrapper = await mountStatus(
      readyBody({ store: true, mongo: false, mqtt: true }),
    );

    expect(wrapper.text()).toContain("未连接");
    expect(wrapper.text()).toContain("历史回放与曲线会是空的");
  });

  it("broker 掉线说出界面会长什么样", async () => {
    // The failure mode that gets misread as "the vehicles stopped".
    const wrapper = await mountStatus(
      readyBody({ store: true, mongo: true, mqtt: false }),
    );

    expect(wrapper.text()).toContain("车都停了");
  });

  it("每一项状态都有词，不只有颜色", async () => {
    const wrapper = await mountStatus(
      readyBody({ store: true, mongo: true, mqtt: true }),
    );
    const rows = wrapper.findAll("ul > li");

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // A dot alone says nothing to a colourblind operator and nothing at all to a
      // screen reader, so every row carries its state as text.
      expect(row.text().trim().length).toBeGreaterThan(0);
    }
  });

  it("并排显示两个时钟，因为时钟偏移只有这样才看得见", async () => {
    const store = useFleetStore();
    store.state.serverUpdatedAt = "2026-08-31T00:00:00.000Z";
    store.state.lastUpdateAt = "2026-08-31T00:00:08.000Z";
    const wrapper = await mountStatus(
      readyBody({ store: true, mongo: true, mqtt: true }),
    );

    expect(wrapper.text()).toContain("后端标记的更新时间");
    expect(wrapper.text()).toContain("本浏览器收到的时间");
    expect(wrapper.text()).toContain("本机时钟偏了");
  });

  it("没有留存数据时说出来，并且不给一个按不动的按钮", async () => {
    const wrapper = await mountStatus(
      readyBody({ store: true, mongo: true, mqtt: true }),
    );
    const clear = wrapper
      .findAll("button")
      .find((button) => button.text().includes("清除"));

    expect(wrapper.text()).toContain("没有留存任何 NavFleet 数据");
    expect(clear?.attributes("disabled")).toBeDefined();
  });

  it("列出这个浏览器实际留着的东西", async () => {
    localStorage.setItem("navfleet:theme", "dark");
    sessionStorage.setItem("navfleet:ros-scene-views:v2", "{}");
    const wrapper = await mountStatus(
      readyBody({ store: true, mongo: true, mqtt: true }),
    );

    expect(wrapper.text()).toContain("主题偏好");
    expect(wrapper.text()).toContain("场景地图视图记忆");
    expect(wrapper.findAll("tbody tr")).toHaveLength(2);
    expect(
      wrapper
        .findAll("button")
        .find((button) => button.text().includes("清除"))
        ?.attributes("disabled"),
    ).toBeUndefined();
  });

  it("说明清除后会重新加载，而不是悄悄留着旧偏好", async () => {
    // The modules that wrote these keys read storage once at import, so a clear
    // without a reload leaves the old preference running — a half-action that reads
    // as broken.
    localStorage.setItem("navfleet:theme", "dark");
    const wrapper = await mountStatus(
      readyBody({ store: true, mongo: true, mqtt: true }),
    );

    expect(wrapper.text()).toContain("清除后页面会重新加载");
  });
});

describe("场景", () => {
  const scene = (patch: Record<string, unknown> = {}) => ({
    sceneId: "yard",
    sceneName: "北区堆场",
    mapFrame: "map",
    resolution: 0.05,
    width: 800,
    height: 600,
    origin: { x: 0, y: 0, yaw: 0 },
    ...patch,
  });

  /** `ok` for every URL unless it is named in `missing`. */
  const stubResources = (missing: readonly string[] = []) => {
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        new Response(null, {
          status: missing.includes(String(input)) ? 404 : 206,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  const seedDevices = (): void => {
    useFleetStore().ingestPayload(
      {
        fleetName: "示范车队",
        topicPattern: "/fleet/{deviceId}/vehicle_info",
        devices: [
          { deviceId: "agv-01", deviceName: "A01 巡检车", sceneId: "yard" },
          { deviceId: "agv-02", deviceName: "A02 牵引车", sceneId: "yard" },
          { deviceId: "agv-09", deviceName: "A09 叉车", sceneId: "dock" },
        ],
      },
      "api",
    );
  };

  const mountScenes = async (items: Record<string, unknown>[]) => {
    vi.spyOn(fleetApi, "getScenes").mockResolvedValue({
      items: items as never,
    });
    return mountAt(ScenesView, "/admin/scenes");
  };

  it("检查每一个配置了的资源，并说明取不到会看到什么", async () => {
    // The confusing failure this page exists for: "no backdrop configured" and
    // "configured and 404" look identical on the map. Phase 1 shipped with
    // `scenes.json` naming three SVGs that did not exist.
    stubResources(["/scene-maps/yard.png"]);
    const wrapper = await mountScenes([
      scene({ imageUrl: "/scene-maps/yard.png" }),
    ]);

    expect(wrapper.text()).toContain("取不到");
    expect(wrapper.text()).toContain("地图没有底图");
  });

  it("取得到的资源标成可取得", async () => {
    stubResources();
    const wrapper = await mountScenes([
      scene({ imageUrl: "/scene-maps/yard.png" }),
    ]);

    expect(wrapper.text()).toContain("可取得");
    expect(wrapper.text()).not.toContain("取不到");
  });

  it("只请求一个字节，测的是地图自己会走的那条路", async () => {
    // A `HEAD` can be answered by a different code path than the `GET` the map will
    // issue, and a point cloud can be tens of megabytes.
    const fetchMock = stubResources();
    await mountScenes([scene({ pointCloudUrl: "/scene-maps/yard.pcd" })]);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Range).toBe("bytes=0-0");
    expect(init.method).toBeUndefined();
  });

  it("先说有几个场景出了问题，那是有人来这一页要的答案", async () => {
    stubResources(["/scene-maps/a.png"]);
    const wrapper = await mountScenes([
      scene({ sceneId: "a", imageUrl: "/scene-maps/a.png" }),
      scene({ sceneId: "b", imageUrl: "/scene-maps/b.png" }),
    ]);

    expect(wrapper.text()).toContain("1 个场景有取不到的资源");
  });

  it("没有配置资源的场景说自己只提供坐标范围", async () => {
    stubResources();
    const wrapper = await mountScenes([scene()]);

    expect(wrapper.text()).toContain("没有配置任何地图资源");
  });

  it("没有 bounds 时按宽高与分辨率推出范围，并说明是推出来的", async () => {
    // The same derivation `SceneMap` does, so the page describes the extent the map
    // will actually use rather than saying "--".
    stubResources();
    const wrapper = await mountScenes([scene()]);

    expect(wrapper.text()).toContain("40.0 × 30.0 m");
    expect(wrapper.text()).toContain("由宽高与分辨率推出");
  });

  it("有 bounds 时直接用它", async () => {
    stubResources();
    const wrapper = await mountScenes([
      scene({ bounds: { minX: -10, maxX: 60, minY: -5, maxY: 120 } }),
    ]);

    expect(wrapper.text()).toContain("x -10.0 – 60.0");
  });

  it("列出在这个场景上的车辆 —— 地图坏了为什么要紧就在这里", async () => {
    seedDevices();
    stubResources();
    const wrapper = await mountScenes([scene()]);

    expect(wrapper.text()).toContain("A01 巡检车、A02 牵引车");
    expect(wrapper.text()).not.toContain("A09 叉车");
  });

  it("场景为空说清后果，而不是留一片空白", async () => {
    stubResources();
    const wrapper = await mountScenes([]);

    expect(wrapper.text()).toContain("没有配置任何场景");
    expect(wrapper.text()).toContain("GPS");
  });

  it("列表请求失败就报出来", async () => {
    stubResources();
    vi.spyOn(fleetApi, "getScenes").mockRejectedValue(new Error("HTTP 503"));
    const wrapper = await mountAt(ScenesView, "/admin/scenes");

    expect(wrapper.text()).toContain("HTTP 503");
  });
});

describe("管理落地页", () => {
  it("做好的分区是链接，没做的不是", async () => {
    // A card that looks clickable and is not would make this page worse than a plain
    // list. Navigation stays an anchor so ⌘-click and "copy link address" work.
    const wrapper = await mountAt(AdminView, "/admin");
    const links = wrapper.findAll("a");

    expect(links.map((link) => link.attributes("href")).sort()).toEqual([
      "/admin/scenes",
      "/admin/system",
    ]);
    // The unbuilt ones still say which PR brings them, rather than going quiet.
    expect(wrapper.text()).toContain("PR 15B");
    expect(wrapper.text()).toContain("PR 16C");
  });

  it("不把未实现的分区说成已就绪", async () => {
    const wrapper = await mountAt(AdminView, "/admin");
    const readyBadges = wrapper
      .findAll("span")
      .filter((span) => span.text() === "已就绪");

    expect(readyBadges).toHaveLength(2);
  });
});
