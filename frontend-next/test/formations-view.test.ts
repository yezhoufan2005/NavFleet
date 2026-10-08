import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import FormationsView from "@/views/admin/FormationsView.vue";

/**
 * 部署 / 编队 (1.6.2; split out of the 设备接入 onboarding page). The view reads the vehicle list for
 * its member picker and writes the whole formation array back; the backend validates
 * formation→vehicle integrity. Here we cover the view: list + count, a create that writes the
 * whole array, and the client-side "at least one vehicle" guard. Reka dialogs teleport to <body>.
 */
enableAutoUnmount(afterEach);

const VEHICLES = [
  {
    deviceId: "agv-1",
    deviceName: "一号车",
    gpsEnabled: true,
    rosMapEnabled: true,
    tags: [],
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
    routes: [{ path: "/deploy/formations", component: FormationsView }],
  });
  await router.push("/deploy/formations");
  await router.isReady();
  const wrapper = mount(FormationsView, { global: { plugins: [router] } });
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

describe("FormationsView — list", () => {
  it("挂载即拉取并列出编队，计数用「共 N 条记录」", async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("编队甲");
    expect(wrapper.text()).toContain("共 1 条记录");
  });
});

describe("FormationsView — create", () => {
  it("选中车辆后保存，把整份编队数组写回", async () => {
    const put = vi.spyOn(fleetApi, "putFormationConfig").mockResolvedValue({
      formations: [
        ...FORMATIONS,
        { formationId: "f-b", formationName: "f-b", deviceIds: ["agv-1"] },
      ],
    });
    const wrapper = await mountView();

    await wrapper.get("button").trigger("click"); // 新增编队 (header action)
    const idInput =
      document.body.querySelector<HTMLInputElement>("input[type='text']")!;
    idInput.value = "f-b";
    idInput.dispatchEvent(new Event("input"));
    document.body
      .querySelector<HTMLInputElement>("input[type='checkbox']")!
      .dispatchEvent(new Event("change"));
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

    await wrapper.get("button").trigger("click");
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

describe("FormationsView — edit & delete", () => {
  it("打开编辑对话框预填，保存写回整份数组", async () => {
    const put = vi
      .spyOn(fleetApi, "putFormationConfig")
      .mockResolvedValue({ formations: [...FORMATIONS] });
    const wrapper = await mountView();

    await wrapper
      .findAll("button")
      .find((b) => b.text() === "编辑")!
      .trigger("click");
    await flushPromises();
    expect(bodyText()).toContain("编辑编队");
    const nameInput = [
      ...document.body.querySelectorAll<HTMLInputElement>("input[type='text']"),
    ].find((input) => input.value === "编队甲");
    expect(nameInput).toBeDefined();

    document.body.querySelector("form")!.dispatchEvent(new Event("submit"));
    await flushPromises();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0].map((f) => f.formationId)).toEqual(["f-a"]);
  });

  it("确认后写回过滤掉该编队的数组", async () => {
    const put = vi
      .spyOn(fleetApi, "putFormationConfig")
      .mockResolvedValue({ formations: [] });
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
    expect(put.mock.calls[0]![0]).toEqual([]);
  });
});
