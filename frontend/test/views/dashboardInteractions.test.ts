/**
 * Dashboard interaction handlers.
 *
 * These are the view's own logic rather than the store's: which selection
 * survives a click (a device clicked inside a formation must not silently drop
 * the formation filter), when a device id is worth showing next to its name, and
 * the collapse preference that has to outlive a reload. All of it was previously
 * unexercised — the view was only ever mounted, never operated.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DashboardView from "../../src/views/DashboardView.vue";
import { useFleetStore } from "../../src/stores/fleet";
import { rawDevice, rawFormation, snapshotPayload, windowFleetApi } from "../helpers/fleetFixtures";

let store: ReturnType<typeof useFleetStore>;

const FLEET_COLLAPSE_KEY = "navfleet:fleet-collapsed";

const mountDashboard = () =>
  mount(DashboardView, {
    global: {
      stubs: {
        GpsMap: { template: "<div class='gps-map-stub' />" },
        RosSceneMap: { template: "<div class='ros-map-stub' />" },
      },
    },
  });

/** Two devices in one formation, plus a loner, so filtering is observable. */
const seedFleet = (): void => {
  store.registerWindowApi();
  windowFleetApi().updateFromPayload(
    snapshotPayload(
      [
        rawDevice("agv-1", { formationIds: ["f-1"] }),
        rawDevice("agv-2", { formationIds: ["f-1"] }),
        rawDevice("agv-3"),
      ],
      [rawFormation("f-1", ["agv-1", "agv-2"])],
    ),
  );
};

beforeEach(() => {
  setActivePinia(createPinia());
  store = useFleetStore();
  window.localStorage.removeItem(FLEET_COLLAPSE_KEY);
});

describe("DashboardView selection", () => {
  it("selects the clicked device", async () => {
    seedFleet();
    const wrapper = mountDashboard();

    await wrapper.findAll(".device-item")[1].trigger("click");

    expect(store.state.selectedDeviceId).toBe("agv-2");

    wrapper.unmount();
  });

  it("keeps the formation filter when picking another device inside it", async () => {
    seedFleet();
    const wrapper = mountDashboard();

    await wrapper.get(".formation-chip").trigger("click");
    expect(store.state.selectedFormationId).toBe("f-1");

    // The list is filtered to the formation, so index 1 is its second member.
    await wrapper.findAll(".device-item")[1].trigger("click");

    expect(store.state.selectedDeviceId).toBe("agv-2");
    expect(store.state.selectedFormationId).toBe("f-1");

    wrapper.unmount();
  });

  it("clears the formation filter and shows every device again", async () => {
    seedFleet();
    const wrapper = mountDashboard();

    await wrapper.get(".formation-chip").trigger("click");
    expect(wrapper.findAll(".device-item")).toHaveLength(2);

    await wrapper.get(".formation-clear-btn").trigger("click");

    expect(store.state.selectedFormationId).toBe("");
    expect(wrapper.findAll(".device-item")).toHaveLength(3);

    wrapper.unmount();
  });
});

describe("DashboardView device labels", () => {
  it("shows the id only for names that are ambiguous", () => {
    store.registerWindowApi();
    windowFleetApi().updateFromPayload(
      snapshotPayload([
        rawDevice("agv-1", { deviceName: "叉车" }),
        rawDevice("agv-2", { deviceName: "叉车" }),
        rawDevice("agv-3", { deviceName: "牵引车" }),
      ]),
    );

    const wrapper = mountDashboard();
    const subtitles = wrapper.findAll(".device-subtitle").map((node) => node.text());

    // Both "叉车" rows must be distinguishable; the unique name needs no id.
    expect(subtitles).toEqual(["agv-1", "agv-2"]);

    wrapper.unmount();
  });
});

describe("DashboardView map mode", () => {
  it("switches between the GPS and ROS surfaces", async () => {
    seedFleet();
    const wrapper = mountDashboard();

    expect(wrapper.find(".gps-map-stub").exists()).toBe(true);

    await wrapper.findAll(".map-tabs .tab-btn")[1].trigger("click");

    expect(store.state.selectedMapMode).toBe("scene");

    wrapper.unmount();
  });
});

describe("DashboardView fleet panel collapse", () => {
  it("hides the device list and remembers the choice", async () => {
    seedFleet();
    const wrapper = mountDashboard();
    expect(wrapper.findAll(".device-item")).toHaveLength(3);

    await wrapper.get(".panel-collapse-btn").trigger("click");

    expect(wrapper.findAll(".device-item")).toHaveLength(0);
    expect(window.localStorage.getItem(FLEET_COLLAPSE_KEY)).toBe("1");

    wrapper.unmount();
  });

  it("starts collapsed when that is what was stored", () => {
    window.localStorage.setItem(FLEET_COLLAPSE_KEY, "1");
    seedFleet();

    const wrapper = mountDashboard();

    expect(wrapper.findAll(".device-item")).toHaveLength(0);
    expect(wrapper.get(".panel-collapse-btn").attributes("aria-label")).toBe("展开设备列表");

    wrapper.unmount();
  });
});
