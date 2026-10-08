import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import VehiclesView from "@/views/admin/VehiclesView.vue";

/**
 * 部署 / 车辆 (1.6.2; split out of the 设备接入 onboarding page). The write path's validation is the
 * backend's job (tested there); here we cover the view: it lists the configured vehicles, a create
 * writes the *whole* array back (read-modify-write, like the codebook import), an empty id is
 * blocked client-side, and a delete PUTs the filtered array. Reka dialogs teleport to <body>.
 */
enableAutoUnmount(afterEach);

const VEHICLES = [
  {
    deviceId: "agv-1",
    deviceName: "一号车",
    gpsEnabled: true,
    rosMapEnabled: true,
    tags: ["巡检"],
  },
  {
    deviceId: "agv-2",
    deviceName: "二号车",
    gpsEnabled: false,
    rosMapEnabled: true,
    tags: [],
  },
];

const mountView = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/deploy", component: VehiclesView }],
  });
  await router.push("/deploy");
  await router.isReady();
  const wrapper = mount(VehiclesView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

const bodyText = (): string => document.body.textContent ?? "";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.spyOn(fleetApi, "getVehicleConfig").mockResolvedValue({
    vehicles: [...VEHICLES],
  });
  vi.spyOn(fleetApi, "getScenes").mockResolvedValue({
    items: [{ sceneId: "yard", sceneName: "北区" }] as never,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VehiclesView — list", () => {
  it("挂载即拉取并列出车辆，计数用「共 N 条记录」", async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("一号车");
    expect(wrapper.text()).toContain("二号车");
    expect(wrapper.text()).toContain("共 2 条记录");
  });
});

describe("VehiclesView — create", () => {
  it("填 ID 后保存，把整份车辆数组写回", async () => {
    const put = vi.spyOn(fleetApi, "putVehicleConfig").mockResolvedValue({
      vehicles: [...VEHICLES, { deviceId: "agv-9", deviceName: "agv-9" }],
    });
    const wrapper = await mountView();

    await wrapper.get("button").trigger("click"); // 新增车辆 (header action)
    const idInput =
      document.body.querySelector<HTMLInputElement>("input[type='text']")!;
    idInput.value = "agv-9";
    idInput.dispatchEvent(new Event("input"));
    await flushPromises();
    document.body.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flushPromises();

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0].map((v) => v.deviceId)).toEqual([
      "agv-1",
      "agv-2",
      "agv-9",
    ]);
  });

  it("空 ID 被前端拦下，不发请求", async () => {
    const put = vi.spyOn(fleetApi, "putVehicleConfig");
    const wrapper = await mountView();

    await wrapper.get("button").trigger("click");
    document.body.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flushPromises();

    expect(bodyText()).toContain("请输入设备 ID");
    expect(put).not.toHaveBeenCalled();
  });
});

describe("VehiclesView — edit & delete", () => {
  it("打开编辑对话框，预填该车字段", async () => {
    const wrapper = await mountView();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "编辑")!
      .trigger("click");
    await flushPromises();

    expect(bodyText()).toContain("编辑车辆");
    const nameInput = [
      ...document.body.querySelectorAll<HTMLInputElement>("input[type='text']"),
    ].find((input) => input.value === "一号车");
    expect(nameInput).toBeDefined();
  });

  it("确认后写回过滤掉该车的数组", async () => {
    const put = vi
      .spyOn(fleetApi, "putVehicleConfig")
      .mockResolvedValue({ vehicles: [VEHICLES[1]!] });
    const wrapper = await mountView();

    await wrapper
      .findAll("button")
      .find((b) => b.text() === "删除")!
      .trigger("click");
    await flushPromises();
    [...document.body.querySelectorAll("button")]
      .find((b) => b.textContent?.trim() === "删除")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0].map((v) => v.deviceId)).toEqual(["agv-2"]);
  });
});
