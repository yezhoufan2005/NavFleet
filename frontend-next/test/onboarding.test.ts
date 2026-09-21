import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import DevicesOnboardingView from "@/views/admin/DevicesOnboardingView.vue";

/**
 * 设备接入向导 (Phase 18). The write path's validation is the backend's job (and is tested
 * there); here we cover the view: it lists the configured vehicles/formations, a create writes
 * the *whole* array back (read-modify-write, like the codebook import), an empty id is blocked
 * client-side, and a delete PUTs the filtered array. Reka dialogs teleport to <body>, so the
 * dialog form is queried there rather than through the wrapper.
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
const FORMATIONS = [
  {
    formationId: "f-a",
    formationName: "编队甲",
    deviceIds: ["agv-1", "agv-2"],
  },
];

const mountView = async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/admin/onboarding", component: DevicesOnboardingView }],
  });
  await router.push("/admin/onboarding");
  await router.isReady();
  const wrapper = mount(DevicesOnboardingView, {
    global: { plugins: [router] },
  });
  await flushPromises();
  return wrapper;
};

const bodyText = (): string => document.body.textContent ?? "";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.spyOn(fleetApi, "getVehicleConfig").mockResolvedValue({
    vehicles: [...VEHICLES],
  });
  vi.spyOn(fleetApi, "getFormationConfig").mockResolvedValue({
    formations: [...FORMATIONS],
  });
  vi.spyOn(fleetApi, "getScenes").mockResolvedValue({
    items: [{ sceneId: "yard", sceneName: "北区" }] as never,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// APPEND-TESTS

describe("列表", () => {
  it("挂载即拉取并列出车辆与编队", async () => {
    const wrapper = await mountView();
    // Rendered content proves load() ran against both config endpoints.
    expect(wrapper.text()).toContain("一号车");
    expect(wrapper.text()).toContain("二号车");
    expect(wrapper.text()).toContain("编队甲");
    expect(wrapper.text()).toContain("车辆（2）");
    expect(wrapper.text()).toContain("编队（1）");
  });
});

describe("新增车辆", () => {
  it("填 ID 后保存，把整份车辆数组写回", async () => {
    const put = vi.spyOn(fleetApi, "putVehicleConfig").mockResolvedValue({
      vehicles: [...VEHICLES, { deviceId: "agv-9", deviceName: "agv-9" }],
    });
    const wrapper = await mountView();

    await wrapper.get("button").trigger("click"); // header 新增车辆 is the first button
    // The dialog teleports to body; the deviceId input is the first text input there.
    const idInput =
      document.body.querySelector<HTMLInputElement>("input[type='text']")!;
    idInput.value = "agv-9";
    idInput.dispatchEvent(new Event("input"));
    await flushPromises();
    document.body.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flushPromises();

    expect(put).toHaveBeenCalledTimes(1);
    const arg = put.mock.calls[0]![0];
    expect(arg.map((v) => v.deviceId)).toEqual(["agv-1", "agv-2", "agv-9"]);
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

describe("删除车辆", () => {
  it("确认后写回过滤掉该车的数组", async () => {
    const put = vi
      .spyOn(fleetApi, "putVehicleConfig")
      .mockResolvedValue({ vehicles: [VEHICLES[1]!] });
    const wrapper = await mountView();

    // The 删除 button for the first vehicle row.
    const deleteButton = wrapper
      .findAll("button")
      .find((b) => b.text() === "删除");
    await deleteButton!.trigger("click");
    await flushPromises();

    // UiConfirmDialog's confirm button is in the body; find the one matching the label.
    const confirmButton = [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "删除",
    )!;
    confirmButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    expect(put).toHaveBeenCalledTimes(1);
    const arg = put.mock.calls[0]![0];
    expect(arg.map((v) => v.deviceId)).toEqual(["agv-2"]);
  });
});

describe("编辑车辆", () => {
  it("打开编辑对话框，预填该车字段", async () => {
    const wrapper = await mountView();
    const editButton = wrapper
      .findAll("button")
      .find((b) => b.text() === "编辑");
    await editButton!.trigger("click");
    await flushPromises();

    // Edit dialog (teleported) shows the edit title and the vehicle's name prefilled.
    expect(bodyText()).toContain("编辑车辆");
    const nameInput = [
      ...document.body.querySelectorAll<HTMLInputElement>("input[type='text']"),
    ].find((input) => input.value === "一号车");
    expect(nameInput).toBeDefined();
  });
});

describe("新增编队", () => {
  it("选中车辆后保存，把整份编队数组写回", async () => {
    const put = vi.spyOn(fleetApi, "putFormationConfig").mockResolvedValue({
      formations: [
        ...FORMATIONS,
        { formationId: "f-b", formationName: "f-b", deviceIds: ["agv-1"] },
      ],
    });
    const wrapper = await mountView();

    const addFormation = wrapper
      .findAll("button")
      .find((b) => b.text() === "新增编队");
    await addFormation!.trigger("click");
    await flushPromises();

    // formationId is the first text input in the formation dialog; check the first vehicle.
    const idInput =
      document.body.querySelector<HTMLInputElement>("input[type='text']")!;
    idInput.value = "f-b";
    idInput.dispatchEvent(new Event("input"));
    const firstDevice = document.body.querySelector<HTMLInputElement>(
      "input[type='checkbox']",
    )!;
    firstDevice.dispatchEvent(new Event("change"));
    await flushPromises();
    document.body.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flushPromises();

    expect(put).toHaveBeenCalledTimes(1);
    const arg = put.mock.calls[0]![0];
    expect(arg.map((f) => f.formationId)).toContain("f-b");
    expect(
      arg.find((f) => f.formationId === "f-b")!.deviceIds.length,
    ).toBeGreaterThan(0);
  });

  it("未选车辆时被前端拦下", async () => {
    const put = vi.spyOn(fleetApi, "putFormationConfig");
    const wrapper = await mountView();

    const addFormation = wrapper
      .findAll("button")
      .find((b) => b.text() === "新增编队");
    await addFormation!.trigger("click");
    await flushPromises();
    const idInput =
      document.body.querySelector<HTMLInputElement>("input[type='text']")!;
    idInput.value = "f-b";
    idInput.dispatchEvent(new Event("input"));
    await flushPromises();
    document.body.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flushPromises();

    expect(bodyText()).toContain("请至少选择一台车辆");
    expect(put).not.toHaveBeenCalled();
  });
});
