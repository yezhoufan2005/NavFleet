import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import type { AlertRulesConfig } from "@navfleet/shared";
import RulesView from "@/views/admin/RulesView.vue";
import {
  __resetNotifications,
  useNotifications,
} from "@/composables/useNotifications";

/**
 * 告警规则 编辑页 (1.6.1). `fleetApi` is mocked; the page is one whole-config form (read-modify
 * -write the fixed { lowBattery, offline } shape), so tests drive the plain inputs and assert the
 * payload `putAlertRules` receives — numbers parsed, empty scope dropped, invalid input blocked.
 */
enableAutoUnmount(afterEach);

const RULES: AlertRulesConfig = {
  lowBattery: {
    enabled: true,
    thresholdPct: 15,
    debounceSeconds: 30,
    scope: { deviceIds: ["agv-1"] },
  },
  offline: { enabled: true, afterSeconds: 90 },
};

let router: Router;
const mountView = async () => {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/alerts/rules", component: RulesView }],
  });
  await router.push("/alerts/rules");
  await router.isReady();
  const wrapper = mount(RulesView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  __resetNotifications();
  vi.spyOn(fleetApi, "getAlertRules").mockResolvedValue({ config: RULES });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const numberInputs = (wrapper: Awaited<ReturnType<typeof mountView>>) =>
  wrapper.findAll('input[type="number"]');
const textValues = (wrapper: Awaited<ReturnType<typeof mountView>>) =>
  wrapper
    .findAll("input")
    .map((input) => (input.element as HTMLInputElement).value);
const save = async (wrapper: Awaited<ReturnType<typeof mountView>>) => {
  // jsdom does not implicitly submit a form when its submit button is clicked, so
  // dispatch the submit the button would have triggered.
  await wrapper.find("form").trigger("submit");
  await flushPromises();
};
const clickButton = async (
  wrapper: Awaited<ReturnType<typeof mountView>>,
  label: string,
) => {
  await wrapper
    .findAll("button")
    .find((button) => button.text().trim() === label)!
    .trigger("click");
  await flushPromises();
};

describe("RulesView — load", () => {
  it("fills the form from the effective rules", async () => {
    const wrapper = await mountView();
    // thresholdPct, debounceSeconds, offline afterSeconds render into number inputs.
    const values = numberInputs(wrapper).map(
      (input) => (input.element as HTMLInputElement).value,
    );
    expect(values).toContain("15");
    expect(values).toContain("30");
    expect(values).toContain("90");
    // The low-battery scope device id round-trips into a text field's value.
    expect(textValues(wrapper)).toContain("agv-1");
  });

  it("reports an error when the rules cannot be loaded", async () => {
    vi.spyOn(fleetApi, "getAlertRules").mockRejectedValue(
      new Error("HTTP 500"),
    );
    const wrapper = await mountView();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });
});

describe("RulesView — save", () => {
  it("PUTs the parsed config, dropping an empty scope", async () => {
    const put = vi
      .spyOn(fleetApi, "putAlertRules")
      .mockResolvedValue({ config: RULES });
    const wrapper = await mountView();
    await save(wrapper);

    expect(put).toHaveBeenCalledTimes(1);
    const config = put.mock.calls[0]![0];
    // Numbers are numbers, not strings.
    expect(config.lowBattery.thresholdPct).toBe(15);
    expect(config.lowBattery.debounceSeconds).toBe(30);
    expect(config.offline.afterSeconds).toBe(90);
    // The low-battery scope survives; offline had no scope, so none is sent.
    expect(config.lowBattery.scope).toEqual({ deviceIds: ["agv-1"] });
    expect(config.offline.scope).toBeUndefined();
    const { items } = useNotifications();
    expect(items.some((toast) => toast.message.includes("已保存"))).toBe(true);
  });

  it("blocks save and shows a message when the threshold is not positive", async () => {
    const put = vi.spyOn(fleetApi, "putAlertRules");
    const wrapper = await mountView();
    // The first number input is the low-battery threshold.
    const threshold = numberInputs(wrapper)[0]!;
    await threshold.setValue("0");
    await save(wrapper);

    expect(put).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').text()).toContain("阈值");
  });

  it("maps a backend rejection to an inline message", async () => {
    vi.spyOn(fleetApi, "putAlertRules").mockRejectedValue(
      new Error("invalid_rules"),
    );
    const wrapper = await mountView();
    await save(wrapper);
    expect(wrapper.find('[role="alert"]').text()).toContain("规则校验未通过");
  });

  it("omits offline afterSeconds when cleared and carries an offline scope", async () => {
    const put = vi
      .spyOn(fleetApi, "putAlertRules")
      .mockResolvedValue({ config: RULES });
    const wrapper = await mountView();
    // Clear the offline 离线判定 (3rd number input) so it falls back to the server default.
    await numberInputs(wrapper)[2]!.setValue("");
    // Set the offline scope's 设备 ID (4th text input) so a scope is sent for offline.
    const textInputs = wrapper.findAll('input[type="text"]');
    await textInputs[3]!.setValue("agv-7, agv-8");
    await save(wrapper);

    const config = put.mock.calls[0]![0];
    expect(config.offline.afterSeconds).toBeUndefined();
    expect(config.offline.scope).toEqual({ deviceIds: ["agv-7", "agv-8"] });
  });

  it("blocks save when the offline judgement time is not positive", async () => {
    const put = vi.spyOn(fleetApi, "putAlertRules");
    const wrapper = await mountView();
    await numberInputs(wrapper)[2]!.setValue("-5");
    await save(wrapper);
    expect(put).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').text()).toContain("离线判定");
  });

  it("blocks save when the debounce window is negative", async () => {
    const put = vi.spyOn(fleetApi, "putAlertRules");
    const wrapper = await mountView();
    await numberInputs(wrapper)[1]!.setValue("-1");
    await save(wrapper);
    expect(put).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').text()).toContain("防抖");
  });

  it("carries every scope dimension for both rules", async () => {
    const put = vi
      .spyOn(fleetApi, "putAlertRules")
      .mockResolvedValue({ config: RULES });
    const wrapper = await mountView();
    const text = wrapper.findAll('input[type="text"]');
    // [0..2] low-battery device/formation/tag scope, [3..5] offline device/formation/tag.
    await text[0]!.setValue("agv-1, agv-2");
    await text[1]!.setValue("line-a");
    await text[2]!.setValue("cold");
    await text[3]!.setValue("agv-9");
    await text[4]!.setValue("line-b");
    await text[5]!.setValue("hot");
    await save(wrapper);

    const config = put.mock.calls[0]![0];
    expect(config.lowBattery.scope).toEqual({
      deviceIds: ["agv-1", "agv-2"],
      formationIds: ["line-a"],
      tags: ["cold"],
    });
    expect(config.offline.scope).toEqual({
      deviceIds: ["agv-9"],
      formationIds: ["line-b"],
      tags: ["hot"],
    });
  });

  it("restores the built-in defaults without writing", async () => {
    const put = vi.spyOn(fleetApi, "putAlertRules");
    const wrapper = await mountView();
    await clickButton(wrapper, "恢复默认");
    // Default low-battery threshold is 20; the loaded value was 15.
    const values = numberInputs(wrapper).map(
      (input) => (input.element as HTMLInputElement).value,
    );
    expect(values).toContain("20");
    expect(put).not.toHaveBeenCalled();
  });
});
