import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { createPinia, setActivePinia } from "pinia";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi, type AdminUser } from "@navfleet/fleet-core";
import type { RbacGroup, RbacRole } from "@navfleet/shared";
import GroupsView from "@/views/admin/GroupsView.vue";
import {
  __resetNotifications,
  useNotifications,
} from "@/composables/useNotifications";

/**
 * 用户 / 用户组 管理页 (1.6.1; split out of 角色与用户组 in 1.6.2). The group editor reads the role
 * and user lists to populate its pickers; `fleetApi` is mocked and the dialog teleports to the body.
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
    routes: [{ path: "/access/groups", component: GroupsView }],
  });
  await router.push("/access/groups");
  await router.isReady();
  const wrapper = mount(GroupsView, { global: { plugins: [router] } });
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

const bodyNameInput = () =>
  document.body.querySelector<HTMLInputElement>("input[type='text']");
const submitBodyForm = async () => {
  document.body.querySelector("form")?.dispatchEvent(new Event("submit"));
  await flushPromises();
};

describe("GroupsView — listing", () => {
  it("renders groups from the API", async () => {
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("夜班");
    expect(wrapper.text()).toContain("运维"); // role name resolved from id
    expect(wrapper.text()).toContain("1 人"); // member count
  });

  it("shows the empty state when there are no groups", async () => {
    vi.spyOn(fleetApi, "getRbacGroups").mockResolvedValue({ groups: [] });
    const wrapper = await mountView();
    expect(wrapper.text()).toContain("还没有用户组");
  });
});

describe("GroupsView — create group", () => {
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

  it("flags kiosk accounts in the member picker", async () => {
    const wrapper = await mountView();
    await clickButton(wrapper, "新建用户组");
    expect(document.body.textContent).toContain("kiosk 只读，不受组提权");
  });
});

describe("GroupsView — edit and delete", () => {
  it("edits and deletes a group", async () => {
    const update = vi
      .spyOn(fleetApi, "updateRbacGroup")
      .mockResolvedValue({ group: group() });
    const del = vi.spyOn(fleetApi, "deleteRbacGroup").mockResolvedValue();
    const wrapper = await mountView();
    await clickButton(wrapper, "编辑");
    await submitBodyForm();
    expect(update).toHaveBeenCalledWith(
      "g1",
      expect.objectContaining({ name: "夜班" }),
    );

    await clickButton(wrapper, "删除");
    const confirm = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "删除",
    );
    confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(del).toHaveBeenCalledWith("g1");

    const { items } = useNotifications();
    expect(items.some((toast) => toast.message.includes("用户组已删除"))).toBe(
      true,
    );
  });
});
