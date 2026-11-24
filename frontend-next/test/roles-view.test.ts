import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi } from "@navfleet/fleet-core";
import { CAPABILITIES, type RbacRole } from "@navfleet/shared";
import { useAuth, __resetAuth } from "@/composables/useAuth";
import RolesView from "@/views/admin/RolesView.vue";
import {
  __resetNotifications,
  useNotifications,
} from "@/composables/useNotifications";

/**
 * 用户 / 角色 管理页 (1.6.1; split out of 角色与用户组 in 1.6.2). `fleetApi` is mocked; the dialogs
 * teleport to `document.body` (reka-ui portals), so dialog assertions query the document.
 */
enableAutoUnmount(afterEach);

const role = (over: Partial<RbacRole> = {}): RbacRole => ({
  id: "r1",
  name: "运维",
  capabilities: ["codebook:write"],
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

let router: Router;
const mountView = async () => {
  setActivePinia(createPinia());
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/access/roles", component: RolesView }],
  });
  await router.push("/access/roles");
  await router.isReady();
  const wrapper = mount(RolesView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  __resetNotifications();
  __resetAuth();
  // These pages sit behind 用户管理; tests run as an admin unless a case says otherwise.
  Object.assign(useAuth().state, {
    user: { username: "root", role: "admin" },
    status: "authenticated",
    capabilities: [...CAPABILITIES],
  });
  vi.spyOn(fleetApi, "getRbacRoles").mockResolvedValue({ roles: [role()] });
  vi.spyOn(fleetApi, "getRbacGroups").mockResolvedValue({ groups: [] });
  vi.spyOn(fleetApi, "getUsers").mockResolvedValue({ users: [] });
});

afterEach(() => {
  __resetAuth();
  vi.restoreAllMocks();
});

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

const bodyNameInput = () =>
  document.body.querySelector<HTMLInputElement>("input[type='text']");
const submitBodyForm = async () => {
  document.body.querySelector("form")?.dispatchEvent(new Event("submit"));
  await flushPromises();
};

describe("RolesView — listing", () => {
  it("renders roles from the API", async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("运维");
    expect(wrapper.text()).toContain("报码字典"); // capability label
    expect(wrapper.text()).toContain("共 1 条记录");
  });

  it("shows the empty state when there are no roles", async () => {
    vi.spyOn(fleetApi, "getRbacRoles").mockResolvedValue({ roles: [] });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("还没有角色");
  });
});

describe("RolesView — create role", () => {
  it("submits name + selected capabilities to the API", async () => {
    const create = vi
      .spyOn(fleetApi, "createRbacRole")
      .mockResolvedValue({ role: role({ id: "r2", name: "审计员" }) });
    const wrapper = await mountView();
    await clickButton(wrapper, "新建角色");

    const nameInput = bodyNameInput();
    expect(nameInput).not.toBeNull();
    nameInput!.value = "审计员";
    nameInput!.dispatchEvent(new Event("input"));
    const auditCheckbox = [...document.body.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("审计日志"))
      ?.querySelector("input");
    auditCheckbox?.dispatchEvent(new Event("change"));
    await flushPromises();
    await submitBodyForm();

    expect(create).toHaveBeenCalledWith({
      name: "审计员",
      capabilities: ["audit:read"],
    });
  });
});

describe("RolesView — delete role in use", () => {
  it("surfaces the role_in_use error as a toast", async () => {
    vi.spyOn(fleetApi, "deleteRbacRole").mockRejectedValue(
      new Error("role_in_use"),
    );
    const wrapper = await mountView();
    await clickButton(wrapper, "删除"); // opens the confirm dialog for the role row
    const confirm = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "删除",
    );
    confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();

    const { items } = useNotifications();
    expect(
      items.some((toast) => toast.message.includes("仍被某个用户组引用")),
    ).toBe(true);
  });
});

describe("RolesView — edit role & error mapping", () => {
  it("prefills the dialog and PATCHes the role by id", async () => {
    const update = vi
      .spyOn(fleetApi, "updateRbacRole")
      .mockResolvedValue({ role: role() });
    const wrapper = await mountView();
    await clickButton(wrapper, "编辑");
    expect(bodyNameInput()?.value).toBe("运维");
    await submitBodyForm();
    expect(update).toHaveBeenCalledWith("r1", {
      name: "运维",
      capabilities: ["codebook:write"],
    });
  });

  it("maps a duplicate-name conflict to an inline message", async () => {
    vi.spyOn(fleetApi, "createRbacRole").mockRejectedValue(
      new Error("conflict"),
    );
    const wrapper = await mountView();
    await clickButton(wrapper, "新建角色");
    bodyNameInput()!.value = "运维";
    bodyNameInput()!.dispatchEvent(new Event("input"));
    await flushPromises();
    await submitBodyForm();
    expect(document.body.textContent).toContain("名称已存在");
  });
});

describe("RolesView — hierarchy", () => {
  it("locks roles carrying a permission the caller lacks", async () => {
    Object.assign(useAuth().state, {
      user: { username: "ops", role: "operator" },
      capabilities: ["alerts:ack", "users:manage"],
    });
    vi.spyOn(fleetApi, "getRbacRoles").mockResolvedValue({
      roles: [
        role({ id: "a", name: "Ackers", capabilities: ["alerts:ack"] }),
        role({ id: "b", name: "Auditors", capabilities: ["audit:read"] }),
      ],
    });
    const wrapper = await mountView();
    const [ackers, auditors] = wrapper.findAll("tbody tr");
    const disabled = (row: typeof ackers) =>
      row!.findAll("button").map((b) => b.attributes("disabled") !== undefined);
    expect(disabled(ackers)).toEqual([false, false]);
    expect(disabled(auditors)).toEqual([true, true]);
  });
});

describe("RolesView — hierarchy through groups", () => {
  it("locks a role a group hands to someone the caller cannot manage", async () => {
    Object.assign(useAuth().state, {
      user: { username: "ops", role: "operator" },
      capabilities: ["alerts:ack", "users:manage"],
    });
    vi.spyOn(fleetApi, "getRbacRoles").mockResolvedValue({
      roles: [
        role({ id: "m", name: "Managers", capabilities: ["users:manage"] }),
      ],
    });
    vi.spyOn(fleetApi, "getRbacGroups").mockResolvedValue({
      groups: [
        {
          id: "g",
          name: "Delegated",
          description: "",
          roleIds: ["m"],
          memberUsernames: ["ops"],
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
    });
    vi.spyOn(fleetApi, "getUsers").mockResolvedValue({
      users: [{ username: "ops", manageable: false } as never],
    });
    const wrapper = await mountView();
    const row = wrapper.get("tbody tr");
    expect(
      row
        .findAll("button")
        .every((b) => b.attributes("disabled") !== undefined),
    ).toBe(true);
    expect(row.find("[title]").attributes("title")).toContain("高于你");
  });
});
