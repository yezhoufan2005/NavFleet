<script setup lang="ts">
/**
 * 角色与用户组 — fine-grained RBAC management (admin, 1.6.1).
 *
 * A **custom role** is a named capability subset; a **user group** binds a set of users to a set
 * of custom roles. A user's effective capabilities are their base-role preset ∪ every capability
 * carried by a role in a group they belong to — so an admin can delegate exactly one ability
 * (say 报码字典 writes) without handing out the full admin role. Users keep their built-in base
 * role (管理员/操作员/只读); this page never changes that — it only layers capabilities on top.
 *
 * The gate is enforced server-side; this page is the console face of `/api/v1/rbac/*`. Every
 * destructive action confirms; the backend's stable error codes (重名 / 角色被组占用 / 不存在)
 * become sentences via `messageFor`.
 */
import { computed, onMounted, ref } from "vue";
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { fleetApi, type AdminUser } from "@navfleet/fleet-core";
import {
  CAPABILITIES,
  type Capability,
  type RbacGroup,
  type RbacRole,
} from "@navfleet/shared";
import PageHeader from "@/components/PageHeader.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";
import { tableClasses } from "@/lib/uiClasses";
import { notify } from "@/composables/useNotifications";

/** Chinese labels for the capability catalog, in `CAPABILITIES` order. */
const CAP_LABELS: Record<Capability, string> = {
  "alerts:ack": "确认告警",
  "vehicles:write": "车辆配置",
  "formations:write": "编队配置",
  "scenes:write": "场景配置",
  "codebook:write": "报码字典",
  "notify:read": "外发记录",
  "notify:write": "外发配置",
  "rules:write": "告警规则",
  "audit:read": "审计日志",
  "users:manage": "用户管理",
  "debug:ingest": "调试注入",
};

const ERROR_MESSAGES: Record<string, string> = {
  conflict: "名称已存在",
  not_found: "目标不存在，或引用了不存在的角色",
  role_in_use: "该角色仍被某个用户组引用，先从组里移除再删除",
};
const messageFor = (error: unknown): string => {
  const code = error instanceof Error ? error.message : "";
  return ERROR_MESSAGES[code] ?? "操作失败，请稍后重试";
};

const INPUT_CLASS =
  "h-9 rounded-sm border border-border-strong bg-surface px-2 text-sm text-ink placeholder:text-ink-subtle";

// ── Data ───────────────────────────────────────────────────────────────────────
const roles = ref<RbacRole[]>([]);
const groups = ref<RbacGroup[]>([]);
const users = ref<AdminUser[]>([]);
const status = ref<"loading" | "ready" | "error">("loading");

const load = async (): Promise<void> => {
  status.value = "loading";
  try {
    const [roleResult, groupResult, userResult] = await Promise.all([
      fleetApi.getRbacRoles(),
      fleetApi.getRbacGroups(),
      fleetApi.getUsers(),
    ]);
    roles.value = roleResult.roles;
    groups.value = groupResult.groups;
    users.value = userResult.users;
    status.value = "ready";
  } catch {
    status.value = "error";
  }
};
onMounted(() => void load());

const roleName = (id: string): string =>
  roles.value.find((role) => role.id === id)?.name ?? id;

// ── Role dialog ──────────────────────────────────────────────────────────────────
const roleMode = ref<"create" | "edit" | null>(null);
const roleEditingId = ref<string | null>(null);
const rName = ref("");
const rCaps = ref<Capability[]>([]);
const roleSaving = ref(false);
const roleError = ref("");

const openCreateRole = (): void => {
  roleEditingId.value = null;
  rName.value = "";
  rCaps.value = [];
  roleError.value = "";
  roleMode.value = "create";
};
const openEditRole = (role: RbacRole): void => {
  roleEditingId.value = role.id;
  rName.value = role.name;
  rCaps.value = [...role.capabilities];
  roleError.value = "";
  roleMode.value = "edit";
};
const closeRoleDialog = (): void => {
  roleMode.value = null;
};
const toggleCap = (capability: Capability): void => {
  rCaps.value = rCaps.value.includes(capability)
    ? rCaps.value.filter((value) => value !== capability)
    : [...rCaps.value, capability];
};

const submitRole = async (): Promise<void> => {
  roleSaving.value = true;
  roleError.value = "";
  const payload = { name: rName.value.trim(), capabilities: rCaps.value };
  try {
    if (roleMode.value === "edit" && roleEditingId.value) {
      await fleetApi.updateRbacRole(roleEditingId.value, payload);
    } else {
      await fleetApi.createRbacRole(payload);
    }
    notify("角色已保存", { type: "success" });
    closeRoleDialog();
    await load();
  } catch (error) {
    roleError.value = messageFor(error);
  } finally {
    roleSaving.value = false;
  }
};

const confirmRoleDelete = ref<RbacRole | null>(null);
const deleteRole = async (): Promise<void> => {
  const role = confirmRoleDelete.value;
  if (!role) return;
  try {
    await fleetApi.deleteRbacRole(role.id);
    notify("角色已删除", { type: "success" });
    await load();
  } catch (error) {
    notify(messageFor(error), { type: "error" });
  } finally {
    confirmRoleDelete.value = null;
  }
};
// ── Group dialog ──────────────────────────────────────────────────────────────────
const groupMode = ref<"create" | "edit" | null>(null);
const groupEditingId = ref<string | null>(null);
const gName = ref("");
const gDesc = ref("");
const gRoleIds = ref<string[]>([]);
const gMembers = ref<string[]>([]);
const groupSaving = ref(false);
const groupError = ref("");

const openCreateGroup = (): void => {
  groupEditingId.value = null;
  gName.value = "";
  gDesc.value = "";
  gRoleIds.value = [];
  gMembers.value = [];
  groupError.value = "";
  groupMode.value = "create";
};
const openEditGroup = (group: RbacGroup): void => {
  groupEditingId.value = group.id;
  gName.value = group.name;
  gDesc.value = group.description;
  gRoleIds.value = [...group.roleIds];
  gMembers.value = [...group.memberUsernames];
  groupError.value = "";
  groupMode.value = "edit";
};
const closeGroupDialog = (): void => {
  groupMode.value = null;
};
const toggleGroupRole = (id: string): void => {
  gRoleIds.value = gRoleIds.value.includes(id)
    ? gRoleIds.value.filter((value) => value !== id)
    : [...gRoleIds.value, id];
};
const toggleGroupMember = (username: string): void => {
  gMembers.value = gMembers.value.includes(username)
    ? gMembers.value.filter((value) => value !== username)
    : [...gMembers.value, username];
};

const submitGroup = async (): Promise<void> => {
  groupSaving.value = true;
  groupError.value = "";
  const payload = {
    name: gName.value.trim(),
    description: gDesc.value.trim(),
    roleIds: gRoleIds.value,
    memberUsernames: gMembers.value,
  };
  try {
    if (groupMode.value === "edit" && groupEditingId.value) {
      await fleetApi.updateRbacGroup(groupEditingId.value, payload);
    } else {
      await fleetApi.createRbacGroup(payload);
    }
    notify("用户组已保存", { type: "success" });
    closeGroupDialog();
    await load();
  } catch (error) {
    groupError.value = messageFor(error);
  } finally {
    groupSaving.value = false;
  }
};

const confirmGroupDelete = ref<RbacGroup | null>(null);
const deleteGroup = async (): Promise<void> => {
  const group = confirmGroupDelete.value;
  if (!group) return;
  try {
    await fleetApi.deleteRbacGroup(group.id);
    notify("用户组已删除", { type: "success" });
    await load();
  } catch (error) {
    notify(messageFor(error), { type: "error" });
  } finally {
    confirmGroupDelete.value = null;
  }
};

const roleDialogTitle = computed(() =>
  roleMode.value === "edit" ? "编辑角色" : "新建角色",
);
const groupDialogTitle = computed(() =>
  groupMode.value === "edit" ? "编辑用户组" : "新建用户组",
);
/** Kiosk accounts never gain capabilities from groups — flag them in the member picker. */
const kioskUsernames = computed(
  () =>
    new Set(
      users.value.filter((user) => user.kiosk).map((user) => user.username),
    ),
);
</script>

<template>
  <PageHeader title="角色与用户组">
    <p v-if="status === 'loading'" class="text-sm text-ink-muted">加载中…</p>
    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="alert"
    >
      无法加载角色与用户组
    </p>

    <template v-else>
      <!-- Custom roles: named capability subsets that groups reference. -->
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-3">
          <h2 class="m-0 text-md font-semibold text-ink">自定义角色</h2>
          <UiButton size="sm" @click="openCreateRole">新建角色</UiButton>
        </div>
        <p v-if="!roles.length" class="text-sm text-ink-muted" role="status">
          还没有自定义角色——角色是一组能力，供用户组引用
        </p>
        <div v-else :class="[tableClasses.wrapper, 'overflow-hidden']">
          <table :class="tableClasses.table">
            <thead :class="tableClasses.thead">
              <tr>
                <th scope="col" class="px-3 py-2">名称</th>
                <th scope="col" class="px-3 py-2">能力</th>
                <th scope="col" class="px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="role in roles"
                :key="role.id"
                :class="tableClasses.row"
              >
                <td class="px-3 py-2 text-ink">{{ role.name }}</td>
                <td class="px-3 py-2 text-ink-muted">
                  {{
                    role.capabilities.map((c) => CAP_LABELS[c]).join("、") ||
                    "—"
                  }}
                </td>
                <td class="px-3 py-2">
                  <span class="flex gap-2">
                    <UiButton
                      variant="ghost"
                      size="sm"
                      @click="openEditRole(role)"
                      >编辑</UiButton
                    >
                    <UiButton
                      variant="ghost"
                      size="sm"
                      @click="confirmRoleDelete = role"
                      >删除</UiButton
                    >
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- User groups: bind users to roles; effective capability = base role ∪ group roles. -->
      <section class="flex flex-col gap-3">
        <div class="flex items-center justify-between gap-3">
          <h2 class="m-0 text-md font-semibold text-ink">用户组</h2>
          <UiButton size="sm" @click="openCreateGroup">新建用户组</UiButton>
        </div>
        <p v-if="!groups.length" class="text-sm text-ink-muted" role="status">
          还没有用户组——它把一批用户绑到若干自定义角色，成员即获得这些角色的能力
        </p>
        <div v-else :class="[tableClasses.wrapper, 'overflow-hidden']">
          <table :class="tableClasses.table">
            <thead :class="tableClasses.thead">
              <tr>
                <th scope="col" class="px-3 py-2">名称</th>
                <th scope="col" class="px-3 py-2">角色</th>
                <th scope="col" class="px-3 py-2">成员</th>
                <th scope="col" class="px-3 py-2">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="group in groups"
                :key="group.id"
                :class="tableClasses.row"
              >
                <td class="px-3 py-2 text-ink">{{ group.name }}</td>
                <td class="px-3 py-2 text-ink-muted">
                  {{ group.roleIds.map(roleName).join("、") || "—" }}
                </td>
                <td class="px-3 py-2 text-ink-muted tabular-nums">
                  {{ group.memberUsernames.length }} 人
                </td>
                <td class="px-3 py-2">
                  <span class="flex gap-2">
                    <UiButton
                      variant="ghost"
                      size="sm"
                      @click="openEditGroup(group)"
                      >编辑</UiButton
                    >
                    <UiButton
                      variant="ghost"
                      size="sm"
                      @click="confirmGroupDelete = group"
                      >删除</UiButton
                    >
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
    <!-- Role dialog -->
    <DialogRoot
      :open="roleMode !== null"
      @update:open="
        (open) => {
          if (!open) closeRoleDialog();
        }
      "
    >
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-50 bg-scrim/55" />
        <DialogContent
          class="fixed top-1/2 left-1/2 z-50 flex w-full max-w-100 -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-md border border-border bg-surface-raised p-5 shadow-overlay"
        >
          <DialogTitle class="text-md font-semibold text-ink">{{
            roleDialogTitle
          }}</DialogTitle>
          <DialogDescription class="sr-only"
            >填写角色名与能力后提交</DialogDescription
          >
          <form
            class="flex flex-col gap-3"
            :aria-busy="roleSaving"
            @submit.prevent="submitRole"
          >
            <label class="flex flex-col gap-1">
              <span class="text-sm font-medium text-ink">名称</span>
              <input
                v-model="rName"
                type="text"
                :disabled="roleSaving"
                :class="INPUT_CLASS"
              />
            </label>
            <fieldset class="flex flex-col gap-1 border-0 p-0">
              <legend class="mb-1 text-sm font-medium text-ink">能力</legend>
              <div class="grid max-h-56 grid-cols-2 gap-1 overflow-auto">
                <label
                  v-for="capability in CAPABILITIES"
                  :key="capability"
                  class="flex items-center gap-2 text-xs text-ink-muted"
                >
                  <input
                    type="checkbox"
                    class="size-4"
                    :checked="rCaps.includes(capability)"
                    :disabled="roleSaving"
                    @change="toggleCap(capability)"
                  />
                  {{ CAP_LABELS[capability] }}
                </label>
              </div>
            </fieldset>
            <p
              v-if="roleError"
              class="m-0 text-sm text-critical-ink"
              role="alert"
            >
              {{ roleError }}
            </p>
            <div class="flex justify-end gap-2">
              <UiButton
                variant="secondary"
                size="sm"
                type="button"
                @click="closeRoleDialog"
                >取消</UiButton
              >
              <UiButton
                size="sm"
                type="submit"
                :disabled="roleSaving || !rName.trim()"
                >保存</UiButton
              >
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
    <!-- Group dialog -->
    <DialogRoot
      :open="groupMode !== null"
      @update:open="
        (open) => {
          if (!open) closeGroupDialog();
        }
      "
    >
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-50 bg-scrim/55" />
        <DialogContent
          class="fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-full max-w-120 -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-auto rounded-md border border-border bg-surface-raised p-5 shadow-overlay"
        >
          <DialogTitle class="text-md font-semibold text-ink">{{
            groupDialogTitle
          }}</DialogTitle>
          <DialogDescription class="sr-only"
            >填写组名、选择角色与成员后提交</DialogDescription
          >
          <form
            class="flex flex-col gap-3"
            :aria-busy="groupSaving"
            @submit.prevent="submitGroup"
          >
            <label class="flex flex-col gap-1">
              <span class="text-sm font-medium text-ink">名称</span>
              <input
                v-model="gName"
                type="text"
                :disabled="groupSaving"
                :class="INPUT_CLASS"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm font-medium text-ink">描述（可选）</span>
              <input
                v-model="gDesc"
                type="text"
                :disabled="groupSaving"
                :class="INPUT_CLASS"
              />
            </label>
            <fieldset class="flex flex-col gap-1 border-0 p-0">
              <legend class="mb-1 text-sm font-medium text-ink">角色</legend>
              <p v-if="!roles.length" class="m-0 text-xs text-ink-subtle">
                还没有自定义角色，先新建一个角色再回来
              </p>
              <div
                v-else
                class="flex max-h-32 flex-col gap-1 overflow-auto rounded-sm border border-border p-2"
              >
                <label
                  v-for="role in roles"
                  :key="role.id"
                  class="flex items-center gap-2 text-xs text-ink-muted"
                >
                  <input
                    type="checkbox"
                    class="size-4"
                    :checked="gRoleIds.includes(role.id)"
                    :disabled="groupSaving"
                    @change="toggleGroupRole(role.id)"
                  />
                  {{ role.name }}
                </label>
              </div>
            </fieldset>
            <fieldset class="flex flex-col gap-1 border-0 p-0">
              <legend class="mb-1 text-sm font-medium text-ink">成员</legend>
              <div
                class="flex max-h-40 flex-col gap-1 overflow-auto rounded-sm border border-border p-2"
              >
                <label
                  v-for="user in users"
                  :key="user.username"
                  class="flex items-center gap-2 text-xs text-ink-muted"
                >
                  <input
                    type="checkbox"
                    class="size-4"
                    :checked="gMembers.includes(user.username)"
                    :disabled="groupSaving"
                    @change="toggleGroupMember(user.username)"
                  />
                  {{ user.displayName || user.username }}
                  <span
                    v-if="kioskUsernames.has(user.username)"
                    class="text-2xs text-ink-subtle"
                    >（kiosk 只读，不受组提权）</span
                  >
                </label>
              </div>
            </fieldset>
            <p
              v-if="groupError"
              class="m-0 text-sm text-critical-ink"
              role="alert"
            >
              {{ groupError }}
            </p>
            <div class="flex justify-end gap-2">
              <UiButton
                variant="secondary"
                size="sm"
                type="button"
                @click="closeGroupDialog"
                >取消</UiButton
              >
              <UiButton
                size="sm"
                type="submit"
                :disabled="groupSaving || !gName.trim()"
                >保存</UiButton
              >
            </div>
          </form>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>

    <UiConfirmDialog
      :open="confirmRoleDelete !== null"
      :title="`删除角色「${confirmRoleDelete?.name ?? ''}」？`"
      description="引用此角色的用户组将失去它带来的能力；被引用时不能删除"
      confirm-label="删除"
      @update:open="
        (open) => {
          if (!open) confirmRoleDelete = null;
        }
      "
      @confirm="deleteRole"
    />
    <UiConfirmDialog
      :open="confirmGroupDelete !== null"
      :title="`删除用户组「${confirmGroupDelete?.name ?? ''}」？`"
      description="组内成员将失去该组带来的附加能力"
      confirm-label="删除"
      @update:open="
        (open) => {
          if (!open) confirmGroupDelete = null;
        }
      "
      @confirm="deleteGroup"
    />
  </PageHeader>
</template>
