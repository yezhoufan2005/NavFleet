import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { fleetApi } from "@navfleet/fleet-core";
import DevicesView from "@/views/DevicesView.vue";
import { useFleetStore } from "@/stores/fleet";
import { __resetDeviceView } from "@/composables/useDeviceView";
import { __resetTheme } from "@/composables/useTheme";

/**
 * Large-fleet rendering cost for the v3 console — the same measurement Phase 10 ran
 * against v1.0.0, so the two are comparable rather than two unrelated numbers.
 *
 * Phase 10 measured first and then **decided not to virtualize**: this platform
 * monitors six vehicles, and virtualization costs Ctrl-F, focus management and an
 * extra scroll container. That decision is inherited here rather than re-litigated,
 * which is exactly why the measurement has to be repeated on the new list: the
 * conclusion depends on the numbers, and the markup changed completely (v1.0.0 drew
 * a list of buttons, this draws a table).
 *
 * Two numbers, and only one is stable enough to assert on:
 *
 * - **DOM nodes per device**, deterministic, and the thing virtualization actually
 *   reduces. Asserted, as a regression guard on row markup.
 * - **Wall-clock mount and update time**, which depends on the machine and on jsdom
 *   (jsdom overstates DOM cost several times over). Printed for a human, never
 *   asserted — a wall-clock assertion in CI is a flake with a schedule.
 *
 * The trigger for revisiting virtualization is the node ceiling being broken or the
 * deployment scale changing by an order of magnitude, not "the list feels long".
 */
enableAutoUnmount(afterEach);

const PANEL = {
  width: 800,
  height: 600,
  top: 0,
  left: 0,
  right: 800,
  bottom: 600,
  x: 0,
  y: 0,
  toJSON: () => ({}),
};

let store: ReturnType<typeof useFleetStore>;

/** A fleet of `count` vehicles, all in one scene, each with its own battery level. */
const fleetOf = (count: number) => ({
  fleetName: "示范车队",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
  devices: Array.from({ length: count }, (_unused, index) => ({
    deviceId: `agv-${String(index + 1).padStart(4, "0")}`,
    deviceName: `AGV ${index + 1}`,
    online: true,
    sceneId: "yard",
    fusion_loc: { x: index % 50, y: index % 30, yaw: 0 },
    vehicle_info: { soc: 20 + (index % 80) },
  })),
});

const ingest = (count: number): void => {
  store.ingestPayload(fleetOf(count), "api");
};

/**
 * The list, not the map. Above `MAP_READABLE_LIMIT` (40) the automatic layout already
 * resolves to the list; the stored preference is what makes the six-vehicle case
 * measure the same surface instead of the map.
 */
const mountList = async () => {
  localStorage.setItem("navfleet:device-layout", "list");
  __resetDeviceView();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:rest(.*)*", component: { template: "<i />" } }],
  });
  await router.push("/devices");
  await router.isReady();
  const wrapper = mount(DevicesView, {
    attachTo: document.body,
    global: { plugins: [router] },
  });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  __resetDeviceView();
  __resetTheme();
  vi.spyOn(fleetApi, "getScenes").mockResolvedValue({ items: [] });
  vi.spyOn(fleetApi, "getScene").mockRejectedValue(new Error("no scene"));
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(PANEL);
  store = useFleetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("large fleet rendering", () => {
  it("renders one page at a time, however large the fleet gets", async () => {
    // Until 14F this asserted 500 rows, because the list had no pagination and mounting
    // all of them was the thing being measured. Pagination changes the premise rather
    // than the conclusion: the reason not to virtualize was that this platform watches
    // six vehicles, and now the row count is bounded by the page size regardless of
    // fleet size — so the case for virtualization is weaker still, not stronger.
    ingest(500);

    const wrapper = await mountList();

    expect(wrapper.findAll("tbody tr.device-row")).toHaveLength(20);
    // And the pager says what the page is a page *of* — 500 rows behind 25 pages.
    const pager = wrapper.get("nav[aria-label='分页']");
    expect(pager.text()).toContain("第 1 / 25 页");
    expect(pager.text()).toContain("共 500 台");
  });

  it("walks to the next page and lands on the next twenty vehicles", async () => {
    ingest(45);
    const wrapper = await mountList();
    const idsOf = () =>
      wrapper
        .findAll("tbody tr.device-row td:nth-child(4)")
        .map((cell) => cell.text());

    expect(idsOf()[0]).toBe("agv-0001");
    await wrapper
      .get("nav[aria-label='分页']")
      .findAll("button")
      .find((button) => button.text() === "下一页")!
      .trigger("click");
    await flushPromises();

    expect(idsOf()).toHaveLength(20);
    expect(idsOf()[0]).toBe("agv-0021");
    // The page travels in the URL, for the same reason the sort does: "it is on page 3"
    // has to be something you can send to a colleague.
    expect(wrapper.vm.$route.query.page).toBe("2");
  });

  it("keeps the per-device node count bounded", async () => {
    ingest(200);

    const wrapper = await mountList();
    const rows = wrapper.findAll("tbody tr.device-row");
    const nodesPerDevice =
      wrapper.get("tbody").element.querySelectorAll("*").length / rows.length;

    // Measured, not assumed: 10 nodes per row — the `tr`, its six `td`, the status
    // cell's wrapper span and its dot, and the device link. v1.0.0's list of buttons
    // was 8, so the table costs two nodes a row more and buys sortable columns later.
    //
    // Only the **ceiling** is asserted, which is Phase 10's choice and still the right
    // one: a planned change (sortable columns) will legitimately add a node or two,
    // and a test that fails on that has stopped measuring what makes a long list slow.
    // A row that grows to dozens of nodes is what turns a 500-device list into a
    // rendering problem, and that is when virtualization is worth reconsidering.
    expect(nodesPerDevice).toBeLessThanOrEqual(16);
  });

  it("reports mount and update timings for the record", async () => {
    const timings: string[] = [];

    for (const count of [6, 50, 200, 500]) {
      setActivePinia(createPinia());
      store = useFleetStore();
      ingest(count);

      const mountStart = performance.now();
      const wrapper = await mountList();
      const mountMs = performance.now() - mountStart;

      // Steady state: every vehicle reports again, which is what a 1 Hz fleet does.
      // `nextTick` must be inside the window — Vue defers the DOM patch, so timing
      // the ingest alone measures the store and not the render.
      const updateStart = performance.now();
      store.ingestPayload(fleetOf(count), "api");
      await nextTick();
      const updateMs = performance.now() - updateStart;

      timings.push(
        `${String(count).padStart(4)} devices: mount ${mountMs.toFixed(1)}ms, full update ${updateMs.toFixed(1)}ms`,
      );
      wrapper.unmount();
    }

    console.log(
      `\n  large-fleet timings (jsdom, indicative only)\n  ${timings.join("\n  ")}\n`,
    );
    expect(timings).toHaveLength(4);
  });
});
