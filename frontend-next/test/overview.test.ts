import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPinia, setActivePinia } from "pinia";
import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
} from "vue-router";
import type { Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import OverviewView from "@/views/OverviewView.vue";
import { useFleetStore } from "@/stores/fleet";

/**
 * The overview page, which is the one page in the new IA with no v1.0.0 counterpart.
 *
 * Its whole claim is "which few need me right now", so the cases below are mostly
 * about ordering and about not crying wolf: a healthy fleet has to say so in one line
 * rather than show forty rows nobody reads.
 */
enableAutoUnmount(afterEach);

void createWebHistory;

const device = (patch: Record<string, unknown> = {}) => ({
  deviceId: "agv-01",
  deviceName: "AGV 01",
  online: true,
  gps: { lat: 31.2, lng: 121.4 },
  ...patch,
});

const code = (value: number, info: string) => ({
  code: value,
  info,
  stamp: null,
});

let store: ReturnType<typeof useFleetStore>;
let router: Router;

const mountPage = async () => {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<i />" } },
      { path: "/devices", component: { template: "<i />" } },
      { path: "/devices/:deviceId", component: { template: "<i />" } },
      { path: "/alerts", component: { template: "<i />" } },
    ],
  });
  await router.push("/");
  await router.isReady();

  const wrapper = mount(OverviewView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

const snapshot = (devices: unknown[], extra: Record<string, unknown> = {}) => ({
  fleetName: "示范车队",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  devices,
  ...extra,
});

beforeEach(() => {
  setActivePinia(createPinia());
  vi.spyOn(fleetApi, "getScenes").mockResolvedValue({ items: [] });
  vi.spyOn(fleetApi, "getScene").mockRejectedValue(new Error("no scene"));
  store = useFleetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the counts", () => {
  it("reports online, alerts, GPS coverage and formations", async () => {
    store.ingestPayload(
      snapshot(
        [
          device(),
          device({ deviceId: "agv-02", online: false }),
          // No fix: it counts against GPS coverage, which is the number v1.0.0's
          // backend computed and no frontend ever read.
          device({ deviceId: "agv-03", gps: null }),
        ],
        {
          formations: [
            {
              formationId: "f-1",
              formationName: "北区编队",
              deviceIds: ["agv-01", "agv-02"],
            },
          ],
        },
      ),
      "api",
    );
    const wrapper = await mountPage();
    const tiles = wrapper.findAll("article");

    expect(tiles[0]?.text()).toContain("2 / 3");
    expect(tiles[0]?.text()).toContain("1 台离线");
    expect(tiles[2]?.text()).toContain("2 / 3");
    expect(tiles[2]?.text()).toContain("1 台无定位");
    expect(tiles[3]?.text()).toContain("1");
  });

  it("says everything is fine rather than colouring a tile amber for nothing", async () => {
    // A permanently amber tile teaches people to ignore amber.
    store.ingestPayload(snapshot([device()]), "api");
    const wrapper = await mountPage();

    expect(wrapper.findAll("article")[0]?.text()).toContain("全部在线");
    expect(wrapper.findAll("article")[1]?.text()).toContain("无告警级");
  });

  it("counts alert severities separately", async () => {
    store.ingestPayload(
      snapshot([
        device({ error_code: code(5102, "路径规划超时") }),
        device({ deviceId: "agv-02", warning_code: code(2203, "电量偏低") }),
      ]),
      "api",
    );
    const wrapper = await mountPage();

    expect(wrapper.findAll("article")[1]?.text()).toContain("其中 1 条告警级");
    const summary = wrapper.find("dl").text();
    expect(summary).toContain("告警");
    expect(summary).toContain("预警");
  });
});

describe("where a tile's tone lives", () => {
  /**
   * The rule 13R-B measured its way to, asserted so it cannot drift back.
   *
   * The number used to wear `text-warning-ink` / `text-critical-ink`. Manual review said
   * «浅色模式数字颜色不清晰», and measuring found light mode had the *higher* contrast
   * (10.59:1 and 11.05:1 against white). The defect was never contrast: `amber-800` and
   * `rose-800` sit at L=0.37, where the hue is not identifiable, so the number read as
   * "dark text" and the one thing the colour was there to say never arrived.
   *
   * So: text wears text colours, and a saturated mark beside it carries the state — the
   * rule this project already follows on its charts.
   */
  const seedWarningAndCritical = () =>
    store.ingestPayload(
      snapshot([
        device({ deviceId: "agv-01", online: false }),
        device({ deviceId: "agv-02", error_code: code(5102, "路径规划超时") }),
      ]),
      "api",
    );

  it("keeps the number in text colour and puts the tone on the card", async () => {
    seedWarningAndCritical();
    const wrapper = await mountPage();
    const tiles = wrapper.findAll("article");

    expect(tiles[0]?.attributes("data-tone")).toBe("warning");
    expect(tiles[1]?.attributes("data-tone")).toBe("critical");

    for (const tile of tiles) {
      const value = tile.find("strong");
      expect(value.classes()).toContain("text-ink");
      expect(value.classes()).not.toContain("text-warning-ink");
      expect(value.classes()).not.toContain("text-critical-ink");
    }
  });

  it("gives a toned tile a saturated mark, and an untoned one none", async () => {
    seedWarningAndCritical();
    const wrapper = await mountPage();
    const tiles = wrapper.findAll("article");

    expect(tiles[0]?.find(".tile-mark").exists()).toBe(true);
    expect(tiles[1]?.find(".tile-mark").exists()).toBe(true);
    // GPS 覆盖 and 编队 are `muted`: a card that is always marked stops being read.
    expect(tiles[2]?.find(".tile-mark").exists()).toBe(false);
    expect(tiles[3]?.find(".tile-mark").exists()).toBe(false);
  });

  it("drops the wash in dark rather than reusing one mix for both themes", async () => {
    /*
     * Asserted against the stylesheet text, because jsdom applies no scoped CSS and the
     * point is the *asymmetry* rather than a computed value. The two themes' wash tokens
     * sit at opposite ends of the lightness scale (`amber-50` L≈0.97 against `amber-900`
     * L≈0.28), so one percentage cannot serve both: the first attempt reused the device
     * row's 60% and the dark amber card came out olive — the same "the hue does not read"
     * failure this change exists to remove, reintroduced in the other theme.
     */
    const source = readFileSync(
      resolve(__dirname, "../src/views/OverviewView.vue"),
      "utf8",
    );
    expect(source).toMatch(/\.stat-tile\s*\{\s*--tile-wash:\s*2\d%/);
    expect(source).toMatch(
      /:root\[data-theme="dark"\]\s\.stat-tile\s*\{\s*--tile-wash:\s*0%/,
    );
    expect(source).toMatch(/prefers-color-scheme:\s*dark/);
  });
});

describe("who needs attention", () => {
  it("orders worst first and leaves healthy vehicles out", async () => {
    store.ingestPayload(
      snapshot([
        device({ deviceId: "agv-01", deviceName: "健康车" }),
        device({
          deviceId: "agv-02",
          deviceName: "预警车",
          warning_code: code(2203, "电量偏低"),
        }),
        device({
          deviceId: "agv-03",
          deviceName: "告警车",
          error_code: code(5102, "路径规划超时"),
        }),
        device({ deviceId: "agv-04", deviceName: "离线车", online: false }),
      ]),
      "api",
    );
    const wrapper = await mountPage();

    const rows = wrapper
      .find("section[aria-labelledby='attention-heading']")
      .findAll("li");
    expect(rows).toHaveLength(3);
    // critical, then warning, then offline — the fleet-core severity order.
    expect(rows[0]?.text()).toContain("告警车");
    expect(rows[1]?.text()).toContain("预警车");
    expect(rows[2]?.text()).toContain("离线车");
    expect(wrapper.text()).not.toContain("健康车");
  });

  it("shows the reported code rather than a bare severity", async () => {
    store.ingestPayload(
      snapshot([device({ error_code: code(5102, "路径规划超时") })]),
      "api",
    );
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain("路径规划超时");
  });

  it("says an offline vehicle's state may be stale instead of showing its last code", async () => {
    // Reporting a stale error as current would claim knowledge we do not have.
    store.ingestPayload(
      snapshot([
        device({ online: false, error_code: code(5102, "路径规划超时") }),
      ]),
      "api",
    );
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("已失联");
    expect(wrapper.text()).not.toContain("路径规划超时");
  });

  it("says so in one line when the whole fleet is healthy", async () => {
    store.ingestPayload(
      snapshot([device(), device({ deviceId: "agv-02" })]),
      "api",
    );
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("全部 2 台设备状态正常");
  });

  it("distinguishes an empty fleet from one still loading", async () => {
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain("后端还没有上报任何设备");

    store.state.realtime.bootstrapPending = true;
    await flushPromises();
    expect(wrapper.text()).toContain("正在获取车队快照");
  });

  it("reserves the stat values rather than letting the cards resize", async () => {
    // A placeholder of the wrong height does not remove the layout jump, it moves it to
    // the moment the data lands — 13px per card in v1.0.0 before this existed. The
    // `value` variant is pinned to the same line box as the number it stands in for.
    const wrapper = await mountPage();
    expect(wrapper.find(".skeleton").exists()).toBe(false);

    store.state.realtime.bootstrapPending = true;
    await flushPromises();

    // One per tile, and the real number is not also rendered underneath it.
    expect(wrapper.findAll(".skeleton-value")).toHaveLength(4);
    expect(wrapper.findAll("article strong")).toHaveLength(0);
  });

  it("does not state 全部在线 about a fleet it has not heard from", async () => {
    // Every tile note is derived from counts that are all zero before the snapshot
    // lands, so a loading 总览 asserted 全部在线 · 无告警级 · 全部已定位 — four
    // confident claims about absent data. Same defect class as `formatNumber(null)`
    // rendering `0.00`, one layer up.
    const wrapper = await mountPage();
    store.state.realtime.bootstrapPending = true;
    await flushPromises();

    const tiles = wrapper.findAll("article");
    expect(tiles).toHaveLength(4);
    for (const tile of tiles) {
      expect(tile.text()).not.toContain("全部");
      expect(tile.text()).not.toContain("无告警级");
    }
    // Both the value and the note are stood in for.
    expect(wrapper.findAll("article .skeleton")).toHaveLength(8);
  });

  it("announces the wait to a screen reader, not only to the eye", async () => {
    // `UiSkeleton` is `aria-hidden`, so `aria-busy` on the owning region is the only
    // thing carrying this state to AT. Before 13T-B the whole of `src` had `aria-busy`
    // in exactly one place — `LoginForm`'s submit — so no data-loading region announced
    // itself at all.
    const wrapper = await mountPage();
    store.state.realtime.bootstrapPending = true;
    await flushPromises();

    const busy = wrapper.findAll("[aria-busy='true']");
    expect(busy.length).toBeGreaterThanOrEqual(2);
    // Each busy region actually owns placeholders — an `aria-busy` with nothing under it
    // announces a wait for content that is not coming.
    for (const region of busy) {
      expect(region.find(".skeleton").exists()).toBe(true);
    }
  });

  it("caps the list and defers to the devices page", async () => {
    store.ingestPayload(
      snapshot(
        Array.from({ length: 9 }, (_unused, index) =>
          device({
            deviceId: `agv-${String(index + 1).padStart(2, "0")}`,
            online: false,
          }),
        ),
      ),
      "api",
    );
    const wrapper = await mountPage();

    expect(
      wrapper
        .find("section[aria-labelledby='attention-heading']")
        .findAll("li"),
    ).toHaveLength(5);
    expect(wrapper.find("a[href='/devices']").exists()).toBe(true);
  });
});

describe("freshness", () => {
  it("keeps the two clocks apart", async () => {
    // A skewed browser clock is how a freshness line ends up reading "-8 秒前", so the
    // relative age is measured on the browser's own clock and the server's timestamp
    // is shown as an absolute time instead of being subtracted from it.
    store.ingestPayload(
      snapshot([device()], { updatedAt: "2026-08-30T02:00:00.000Z" }),
      "api",
    );
    const wrapper = await mountPage();

    expect(wrapper.find("[role='status']").text()).toContain("刚刚");
    expect(store.state.serverUpdatedAt).toBe("2026-08-30T02:00:00.000Z");
    expect(wrapper.find("[role='status']").text()).toContain("服务端");
  });

  it("says there is no data rather than an age of zero", async () => {
    const wrapper = await mountPage();
    expect(wrapper.find("[role='status']").text()).toContain("尚无数据");
  });

  it("counts up as time passes", async () => {
    vi.useFakeTimers();
    try {
      store.ingestPayload(snapshot([device()]), "api");
      const wrapper = await mountPage();
      expect(wrapper.find("[role='status']").text()).toContain("刚刚");

      vi.advanceTimersByTime(90_000);
      await flushPromises();
      expect(wrapper.find("[role='status']").text()).toContain("分钟前");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("formations", () => {
  it("shows the description that v1.0.0 carried and never rendered", async () => {
    store.ingestPayload(
      snapshot([device()], {
        formations: [
          {
            formationId: "f-1",
            formationName: "北区编队",
            description: "负责北区两条巡检线",
            deviceIds: ["agv-01"],
          },
        ],
      }),
      "api",
    );
    const wrapper = await mountPage();

    expect(wrapper.text()).toContain("负责北区两条巡检线");
    expect(wrapper.text()).toContain("1 / 1");
  });

  it("omits the section when no formation is configured", async () => {
    store.ingestPayload(snapshot([device()]), "api");
    const wrapper = await mountPage();

    expect(wrapper.find("#formations-heading").exists()).toBe(false);
    expect(wrapper.findAll("article")[3]?.text()).toContain("未配置编队");
  });

  it("makes each formation a link to the devices page, filtered", async () => {
    // The tile's note used to read 点击查看成员 on a plain `<article>` with no handler,
    // no formations route and nothing to click through to — an affordance that existed
    // only in the copy. The click is here, and the id travels in the query string so it
    // survives a paste and a reload.
    store.ingestPayload(
      snapshot([device()], {
        formations: [
          {
            formationId: "f-1",
            formationName: "北区编队",
            deviceIds: ["agv-01"],
          },
        ],
      }),
      "api",
    );
    const wrapper = await mountPage();

    const link = wrapper
      .findAll("#formations-heading ~ ul a")
      .find((anchor) => anchor.text().includes("北区编队"));
    expect(link?.attributes("href")).toBe("/devices?formation=f-1");
  });

  it("does not claim the tile itself is clickable", async () => {
    // It is still an `<article>`, so the note names where the capability is instead of
    // describing one this element does not have.
    store.ingestPayload(
      snapshot([device()], {
        formations: [
          {
            formationId: "f-1",
            formationName: "北区编队",
            deviceIds: ["agv-01"],
          },
        ],
      }),
      "api",
    );
    const wrapper = await mountPage();
    const tile = wrapper
      .findAll("article")
      .find((item) => item.text().includes("编队"));

    expect(tile?.text()).toContain("可在设备页按编队筛选");
    expect(tile?.text()).not.toContain("点击");
    expect(tile?.find("a").exists()).toBe(false);
  });
});
