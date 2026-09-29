import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi, type AdminUser } from "@navfleet/fleet-core";
import type { RbacGroup, RbacRole } from "@navfleet/shared";
import RolesView from "@/views/admin/RolesView.vue";
import {
  __resetNotifications,
  useNotifications,
} from "@/composables/useNotifications";

/**
 * 角色与用户组 管理页 (1.6.1). `fleetApi` is mocked; the dialogs teleport to `document.body`
 * (reka-ui portals), so dialog assertions query the document rather than the wrapper.
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
const group = (over: Partial<RbacGroup> = {}): RbacGroup => ({
  id: "g1",
  name: "夜班",
  description: "",
  roleIds: ["r1"],
  memberUsernames: ["bob"],
  createdAt: "t",
  updatedAt: "t",
  ...over,
});
const user = (username: string, over: Partial<AdminUser> = {}): AdminUser =>
  ({ username, role: "viewer", displayName: username, ...over }) as AdminUser;

let router: Router;
const mountView = async () => {
  setActivePinia(createPinia());
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/admin/roles", component: RolesView }],
  });
  await router.push("/admin/roles");
  await router.isReady();
  const wrapper = mount(RolesView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
};

beforeEach(() => {
  __resetNotifications();
  vi.spyOn(fleetApi, "getRbacRoles").mockResolvedValue({ roles: [role()] });
  vi.spyOn(fleetApi, "getRbacGroups").mockResolvedValue({ groups: [group()] });
  vi.spyOn(fleetApi, "getUsers").mockResolvedValue({
    users: [user("bob"), user("kio", { kiosk: true })],
  });
});

afterEach(() => {
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

describe("RolesView — listing", () => {
  it("renders roles and groups from the API", async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("运维");
    expect(wrapper.text()).toContain("报码字典"); // capability label
    expect(wrapper.text()).toContain("夜班");
    expect(wrapper.text()).toContain("1 人"); // member count
  });

  it("shows empty states when there are no roles or groups", async () => {
    vi.spyOn(fleetApi, "getRbacRoles").mockResolvedValue({ roles: [] });
    vi.spyOn(fleetApi, "getRbacGroups").mockResolvedValue({ groups: [] });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("还没有自定义角色");
    expect(wrapper.text()).toContain("还没有用户组");
  });
});

describe("RolesView — create role", () => {
  it("submits name + selected capabilities to the API", async () => {
    const create = vi
      .spyOn(fleetApi, "createRbacRole")
      .mockResolvedValue({ role: role({ id: "r2", name: "审计员" }) });
    const wrapper = await mountView();
    await clickButton(wrapper, "新建角色");

    // Dialog content is teleported to the body.
    const nameInput =
      document.body.querySelector<HTMLInputElement>("input[type='text']");
    expect(nameInput).not.toBeNull();
    nameInput!.value = "审计员";
    nameInput!.dispatchEvent(new Event("input"));
    const auditCheckbox = [...document.body.querySelectorAll("label")]
      .find((label) => label.textContent?.includes("审计日志"))
      ?.querySelector("input");
    auditCheckbox?.dispatchEvent(new Event("change"));
    await flushPromises();

    document.body.querySelector("form")?.dispatchEvent(new Event("submit"));
    await flushPromises();

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
    // Confirm (the AlertDialog action) is teleported; find the 删除 action in the body.
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

const bodyNameInput = () =>
  document.body.querySelector<HTMLInputElement>("input[type='text']");
const submitBodyForm = async () => {
  document.body.querySelector("form")?.dispatchEvent(new Event("submit"));
  await flushPromises();
};

describe("RolesView — edit role & error mapping", () => {
  it("prefills the dialog and PATCHes the role by id", async () => {
    const update = vi
      .spyOn(fleetApi, "updateRbacRole")
      .mockResolvedValue({ role: role() });
    const wrapper = await mountView();
    // First 编辑 belongs to the role row (roles table renders before groups).
    await wrapper
      .findAll("button")
      .find((button) => button.text().trim() === "编辑")!
      .trigger("click");
    await flushPromises();
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

describe("RolesView — groups", () => {
  it("creates a group with the selected role and member", async () => {
    const create = vi
      .spyOn(fleetApi, "createRbacGroup")
      .mockResolvedValue({ group: group() });
    const wrapper = await mountView();
    await clickButton(wrapper, "新建用户组");
    bodyNameInput()!.value = "白班";
    bodyNameInput()!.dispatchEvent(new Event("input"));
    const check = (text: string) =>
      [...document.body.querySelectorAll("label")]
        .find((label) => label.textContent?.includes(text))
        ?.querySelector("input")
        ?.dispatchEvent(new Event("change"));
    check("运维"); // the role
    check("bob"); // the member
    await flushPromises();
    await submitBodyForm();
    expect(create).toHaveBeenCalledWith({
      name: "白班",
      description: "",
      roleIds: ["r1"],
      memberUsernames: ["bob"],
    });
  });

  it("edits and deletes a group", async () => {
    const update = vi
      .spyOn(fleetApi, "updateRbacGroup")
      .mockResolvedValue({ group: group() });
    const del = vi.spyOn(fleetApi, "deleteRbacGroup").mockResolvedValue();
    const wrapper = await mountView();
    // The second 编辑 / 删除 belong to the group row.
    const edits = wrapper
      .findAll("button")
      .filter((button) => button.text().trim() === "编辑");
    await edits[1]!.trigger("click");
    await flushPromises();
    await submitBodyForm();
    expect(update).toHaveBeenCalledWith(
      "g1",
      expect.objectContaining({ name: "夜班" }),
    );

    const deletes = wrapper
      .findAll("button")
      .filter((button) => button.text().trim() === "删除");
    await deletes[1]!.trigger("click");
    await flushPromises();
    const confirm = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "删除",
    );
    confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(del).toHaveBeenCalledWith("g1");
  });
});
