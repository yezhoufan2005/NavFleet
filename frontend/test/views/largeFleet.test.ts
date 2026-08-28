/**
 * Large-fleet rendering cost.
 *
 * Phase 10's exit criterion is "no jank with a large fleet", and the obvious
 * lever is list virtualization. Virtualization is not free — it breaks Ctrl-F,
 * complicates focus management and adds a scroll container to reason about — so
 * this measures the cost first instead of assuming it.
 *
 * Two numbers matter, and only one of them is stable enough to assert on:
 *   - DOM nodes per device, which is deterministic and is what virtualization
 *     actually reduces. Asserted, as a regression guard on list markup.
 *   - Wall-clock mount and update time, which depends on the machine and on
 *     jsdom. Recorded to the console for a human to read, never asserted.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import DashboardView from "../../src/views/DashboardView.vue";
import { useFleetStore } from "../../src/stores/fleet";
import { rawDevice, snapshotPayload, windowFleetApi } from "../helpers/fleetFixtures";

let store: ReturnType<typeof useFleetStore>;

const mountDashboard = () =>
  mount(DashboardView, {
    global: {
      stubs: {
        GpsMap: { template: "<div class='gps-map-stub' />" },
        RosSceneMap: { template: "<div class='ros-map-stub' />" },
      },
    },
  });

/** A fleet of `count` devices spread over the scenes the fixtures know about. */
const fleetOf = (count: number) =>
  snapshotPayload(
    Array.from({ length: count }, (_, index) =>
      rawDevice(`agv-${String(index + 1).padStart(4, "0")}`, {
        soc: 20 + (index % 80),
      }),
    ),
  );

const ingest = (count: number): void => {
  store.registerWindowApi();
  windowFleetApi().updateFromPayload(fleetOf(count));
};

beforeEach(() => {
  setActivePinia(createPinia());
  store = useFleetStore();
});

describe("large fleet rendering", () => {
  it("renders every device in the list at 500 devices", () => {
    ingest(500);

    const wrapper = mountDashboard();

    expect(wrapper.findAll(".device-item")).toHaveLength(500);

    wrapper.unmount();
  });

  it("keeps the per-device node count bounded", () => {
    ingest(200);

    const wrapper = mountDashboard();
    const nodesPerDevice =
      wrapper.get(".device-list").element.querySelectorAll("*").length /
      wrapper.findAll(".device-item").length;

    // Currently 8 elements per row (button, 2 wrappers, name, subtitle, status,
    // 2 summary items with their own label/value pairs). The ceiling is what
    // matters: a row that grows to dozens of nodes is what makes a 500-device
    // list a rendering problem, and that is the point to revisit virtualization.
    expect(nodesPerDevice).toBeLessThanOrEqual(16);

    wrapper.unmount();
  });

  it("reports mount and update timings for the record", async () => {
    const timings: string[] = [];

    for (const count of [6, 50, 200, 500]) {
      setActivePinia(createPinia());
      store = useFleetStore();
      ingest(count);

      const mountStart = performance.now();
      const wrapper = mountDashboard();
      const mountMs = performance.now() - mountStart;

      // Steady state: every device reports again, which is what a 1 Hz fleet
      // does. `nextTick` must be inside the window — Vue defers the DOM patch,
      // so timing only the ingest call measures the store and not the render.
      const updateStart = performance.now();
      windowFleetApi().updateFromPayload(fleetOf(count));
      await nextTick();
      const updateMs = performance.now() - updateStart;

      timings.push(
        `${String(count).padStart(4)} devices: mount ${mountMs.toFixed(1)}ms, full update ${updateMs.toFixed(1)}ms`,
      );
      wrapper.unmount();
    }

    console.log(`\n  large-fleet timings (jsdom, indicative only)\n  ${timings.join("\n  ")}\n`);
    expect(timings).toHaveLength(4);
  });
});
