/**
 * Dashboard loading state.
 *
 * The point of these is the distinction the view used to get wrong: before the
 * first snapshot arrives there is no data *yet*, which is not the same thing as
 * no data *matching the filters*. Rendering the filter message during bootstrap
 * told the operator their filters were wrong when nothing had been filtered.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DashboardView from "../../src/views/DashboardView.vue";
import { useFleetStore } from "../../src/stores/fleet";
import { rawDevice, snapshotPayload, windowFleetApi } from "../helpers/fleetFixtures";

let store: ReturnType<typeof useFleetStore>;

// The two map components own an AMap SDK loader and an SVG viewport; neither is
// under test here and both are expensive to mount, so they are stubbed out.
const mountDashboard = () =>
  mount(DashboardView, {
    global: {
      stubs: {
        GpsMap: { template: "<div class='gps-map-stub' />" },
        RosSceneMap: { template: "<div class='ros-map-stub' />" },
      },
    },
  });

beforeEach(() => {
  setActivePinia(createPinia());
  store = useFleetStore();
});

describe("DashboardView bootstrap skeletons", () => {
  it("shows placeholders instead of the empty-filter message while loading", () => {
    store.state.realtime.bootstrapPending = true;

    const wrapper = mountDashboard();

    expect(wrapper.findAll(".skeleton").length).toBeGreaterThan(0);
    expect(wrapper.text()).not.toContain("当前筛选条件下没有设备数据");
    expect(wrapper.text()).not.toContain("当前没有编队配置");

    wrapper.unmount();
  });

  it("marks the loading regions busy so assistive tech is told once, not per bar", () => {
    store.state.realtime.bootstrapPending = true;

    const wrapper = mountDashboard();

    expect(wrapper.get(".headline-stats").attributes("aria-busy")).toBe("true");
    expect(wrapper.get(".device-list").attributes("aria-busy")).toBe("true");
    // The bars themselves stay out of the accessibility tree.
    expect(wrapper.get(".skeleton-stack").attributes("aria-hidden")).toBe("true");

    wrapper.unmount();
  });

  it("reserves the stat value's own line height so nothing jumps on arrival", () => {
    store.state.realtime.bootstrapPending = true;

    const wrapper = mountDashboard();

    // jsdom does no layout, so the guard is on the variant rather than on
    // pixels: `skeleton-value` is the one sized to `.headline-stat strong`.
    // A plain `skeleton-line` here measured 13px short per card in a browser.
    const statPlaceholders = wrapper.findAll(".headline-stat .skeleton");
    expect(statPlaceholders).toHaveLength(4);
    statPlaceholders.forEach((bar) => {
      expect(bar.classes()).toContain("skeleton-value");
    });

    wrapper.unmount();
  });

  it("falls back to the empty state once bootstrap finishes with no devices", () => {
    store.state.realtime.bootstrapPending = false;

    const wrapper = mountDashboard();

    expect(wrapper.findAll(".skeleton")).toHaveLength(0);
    expect(wrapper.text()).toContain("当前筛选条件下没有设备数据");

    wrapper.unmount();
  });

  it("renders real values, not placeholders, once devices have arrived", () => {
    store.registerWindowApi();
    windowFleetApi().updateFromPayload(snapshotPayload([rawDevice("agv-1"), rawDevice("agv-2")]));
    store.state.realtime.bootstrapPending = false;

    const wrapper = mountDashboard();

    expect(wrapper.findAll(".skeleton")).toHaveLength(0);
    expect(wrapper.findAll(".device-item")).toHaveLength(2);
    expect(wrapper.get(".headline-stats").attributes("aria-busy")).toBe("false");

    wrapper.unmount();
  });
});
