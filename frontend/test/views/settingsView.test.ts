/**
 * Settings view.
 *
 * Covers the three things the page is for: choosing a theme with real radio
 * semantics (the header's cycle button is unusable if you cannot see the current
 * icon), clearing the two stores the app writes to the browser, and reporting
 * connection state without opening devtools.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SettingsView from "../../src/views/SettingsView.vue";
import { useFleetStore } from "../../src/stores/fleet";
import { useAlertAck } from "../../src/composables/useAlertAck";
import {
  ROS_VIEW_STORAGE_KEY,
  useSceneViewportPersistence,
} from "../../src/composables/useSceneViewportPersistence";

let store: ReturnType<typeof useFleetStore>;
const ack = useAlertAck();

const factValue = (wrapper: ReturnType<typeof mount>, label: string): string => {
  const terms = wrapper.findAll(".settings-facts dt");
  const index = terms.findIndex((term) => term.text() === label);
  expect(index, `no fact row labelled "${label}"`).toBeGreaterThanOrEqual(0);
  return wrapper.findAll(".settings-facts dd")[index].text();
};

beforeEach(() => {
  setActivePinia(createPinia());
  store = useFleetStore();
  ack.clearAll();
  window.sessionStorage.removeItem(ROS_VIEW_STORAGE_KEY);
});

describe("SettingsView appearance", () => {
  it("offers the three theme preferences as a labelled radio group", () => {
    const wrapper = mount(SettingsView);

    const group = wrapper.get("fieldset");
    expect(group.get("legend").text()).toBe("外观");

    const radios = wrapper.findAll('input[type="radio"][name="theme-preference"]');
    expect(radios.map((radio) => radio.attributes("value"))).toEqual(["dark", "light", "system"]);

    wrapper.unmount();
  });

  it("applies a chosen preference to the document", async () => {
    const wrapper = mount(SettingsView);

    await wrapper.get('input[value="light"]').trigger("change");

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(wrapper.text()).toContain("当前生效：浅色");

    wrapper.unmount();
  });
});

describe("SettingsView local data", () => {
  it("disables both clear buttons when there is nothing stored", () => {
    const wrapper = mount(SettingsView);

    const buttons = wrapper.findAll(".settings-action-row button");
    expect(buttons).toHaveLength(2);
    buttons.forEach((button) => {
      expect(button.attributes("disabled")).toBeDefined();
    });

    wrapper.unmount();
  });

  it("reports and clears acknowledged alerts", async () => {
    ack.acknowledgeMany(["alert-a", "alert-b", "alert-c"]);

    const wrapper = mount(SettingsView);
    expect(wrapper.text()).toContain("3 条记录");

    await wrapper.findAll(".settings-action-row button")[0].trigger("click");

    expect(ack.state.ids.size).toBe(0);
    expect(wrapper.text()).toContain("0 条记录");

    wrapper.unmount();
  });

  it("reports and clears remembered scene views", async () => {
    window.sessionStorage.setItem(
      ROS_VIEW_STORAGE_KEY,
      JSON.stringify({
        dock: { centerX: 1, centerY: 2, scale: 1, updatedAt: 0 },
        yard: { centerX: 3, centerY: 4, scale: 2, updatedAt: 0 },
      }),
    );

    const wrapper = mount(SettingsView);
    expect(wrapper.text()).toContain("2 个场景");

    await wrapper.findAll(".settings-action-row button")[1].trigger("click");

    expect(Object.keys(useSceneViewportPersistence().readSavedSceneViews())).toHaveLength(0);
    expect(wrapper.text()).toContain("0 个场景");

    wrapper.unmount();
  });
});

describe("SettingsView connection facts", () => {
  it("reports the backend and realtime link as unavailable before bootstrap", () => {
    const wrapper = mount(SettingsView);

    expect(factValue(wrapper, "后端接口")).toBe("不可用");
    expect(factValue(wrapper, "实时推送")).toBe("已断开，正在重连");
    expect(factValue(wrapper, "最近更新")).toBe("暂无数据");

    wrapper.unmount();
  });

  it("reflects a connected store", () => {
    store.state.fleetName = "测试车队";
    store.state.topicPattern = "/fleet/{deviceId}/vehicle_info";
    store.state.realtime.apiReady = true;
    store.state.realtime.wsReady = true;

    const wrapper = mount(SettingsView);

    expect(factValue(wrapper, "车队名称")).toBe("测试车队");
    expect(factValue(wrapper, "MQTT 主题模板")).toBe("/fleet/{deviceId}/vehicle_info");
    expect(factValue(wrapper, "后端接口")).toBe("已连接");
    expect(factValue(wrapper, "实时推送")).toBe("已连接");

    wrapper.unmount();
  });
});
