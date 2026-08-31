import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
    // Scoped to the 告警摘要 panel by its heading. Unscoped, `find("dl")` now lands
    // on whichever tile breakdown happens to render first, and would pass for the
    // wrong reason.
    const summary = wrapper
      .findAll("section")
      .find((section) => section.text().includes("告警摘要"))!;
    expect(summary.text()).toContain("告警");
    expect(summary.text()).toContain("预警");
  });

  /**
   * The breakdowns, added after manual review: four cards each holding one number
   * left most of their width empty, and a total is the least actionable form of these
   * numbers — "8 条告警" does not say whether to walk over, "其中 2 条告警级" does.
   */
  it("names the offline vehicles rather than only counting them", async () => {
    store.ingestPayload(
      snapshot([
        device(),
        device({ deviceId: "agv-02", deviceName: "B02 牵引车", online: false }),
      ]),
      "api",
    );
    const wrapper = await mountPage();

    expect(wrapper.findAll("article")[0]?.text()).toContain("B02 牵引车");
  });

  it("caps the names and says how many are left", async () => {
    // A card that lists forty names is a card nobody reads.
    store.ingestPayload(
      snapshot(
        Array.from({ length: 5 }, (_unused, index) =>
          device({
            deviceId: `agv-0${index + 1}`,
            deviceName: `车 ${index + 1}`,
            online: false,
          }),
        ),
      ),
      "api",
    );
    const wrapper = await mountPage();

    expect(wrapper.findAll("article")[0]?.text()).toContain("等 5 台");
  });

  it("splits the alert total by severity inside the card", async () => {
    store.ingestPayload(
      snapshot([
        device({ error_code: code(5102, "路径规划超时") }),
        device({ deviceId: "agv-02", info_code: code(1101, "定位稳定") }),
      ]),
      "api",
    );
    const wrapper = await mountPage();
    const alerts = wrapper.findAll("article")[1]!;

    expect(alerts.findAll("dd").map((cell) => cell.text())).toEqual([
      "1",
      "0",
      "1",
    ]);
  });

  it("says how many formations are intact, which the panel below does not", async () => {
    // Not the per-formation list — the 编队 panel already prints that. What it does
    // not say is which formations can still run a route.
    store.ingestPayload(
      snapshot([device(), device({ deviceId: "agv-02", online: false })], {
        formations: [
          {
            formationId: "f-1",
            formationName: "满员编队",
            deviceIds: ["agv-01"],
          },
          {
            formationId: "f-2",
            formationName: "缺员编队",
            deviceIds: ["agv-01", "agv-02"],
          },
        ],
      }),
      "api",
    );
    const wrapper = await mountPage();
    const formations = wrapper.findAll("article")[3]!;

    expect(formations.text()).toContain("1 个满员");
    expect(formations.text()).toContain("有缺员");
  });

  /**
   * The item manual review raised as "the light-mode numbers are unclear". Measuring
   * said the opposite of what that suggests: light is the *higher*-contrast mode
   * (`warning-ink` 10.59:1 vs the dark pair's 7.45:1 on `surface-raised`). The real
   * problem is that both light inks sit at L≈0.37, where the hue cannot be named — so
   * the number reads as dark text and the signal never arrives.
   *
   * The rule this project's charts already keep: text wears text tokens, and a
   * saturated mark beside it carries the colour.
   */
  it("never paints the numeral with a status colour", async () => {
    store.ingestPayload(
      snapshot([
        device({ deviceId: "agv-02", online: false }),
        device({ error_code: code(5102, "路径规划超时") }),
      ]),
      "api",
    );
    const wrapper = await mountPage();

    for (const value of wrapper.findAll("article strong")) {
      const classes = value.classes();
      expect(classes).toContain("text-ink");
      expect(classes).not.toContain("text-warning-ink");
      expect(classes).not.toContain("text-critical-ink");
    }
  });

  it("carries the tone on a saturated dot instead", async () => {
    store.ingestPayload(
      snapshot([
        device({ deviceId: "agv-02", online: false }),
        device({ error_code: code(5102, "路径规划超时") }),
      ]),
      "api",
    );
    const wrapper = await mountPage();

    expect(wrapper.findAll("article")[0]!.find(".bg-warning").exists()).toBe(
      true,
    );
    expect(wrapper.findAll("article")[1]!.find(".bg-critical").exists()).toBe(
      true,
    );
    // And no dot where there is nothing to flag — a permanently lit dot teaches
    // people to ignore it.
    expect(wrapper.findAll("article")[2]!.find(".bg-warning").exists()).toBe(
      false,
    );
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
    ).toHaveLength(6);
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
});
