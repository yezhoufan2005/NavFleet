<script setup lang="ts">
/**
 * 用户 / 用户组 — RBAC user groups (admin, 1.6.1; split out of the old 角色与用户组 page in 1.6.2).
 *
 * A **user group** binds a set of users to a set of custom roles (defined on the 角色 tab). A
 * member's effective capabilities are their base-role preset ∪ every capability carried by a role
 * in a group they belong to — so a group is how an admin actually hands out a delegated ability.
 * Kiosk accounts are read-only by construction and never gain capabilities from a group, so the
 * member picker flags them.
 *
 * The gate is enforced server-side; this page is the console face of `/api/v1/rbac/groups`. It
 * reads the role and user lists to populate its picker. Every destructive action confirms; stable
 * backend error codes (重名 / 引用不存在的角色 / 不存在) become sentences via `messageFor`.
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
import type { RbacGroup, RbacRole } from "@navfleet/shared";
import PageHeader from "@/components/PageHeader.vue";
import AppSectionTabs from "@/components/shell/AppSectionTabs.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";
import { tableClasses } from "@/lib/uiClasses";
import { notify } from "@/composables/useNotifications";

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
  <PageHeader title="用户">
    <template #actions>
      <UiButton size="sm" @click="openCreateGroup">新建用户组</UiButton>
    </template>

    <AppSectionTabs />

    <p v-if="status === 'loading'" class="text-sm text-ink-muted">加载中…</p>
    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="alert"
    >
      无法加载用户组
    </p>

    <template v-else>
      <p v-if="!groups.length" class="text-sm text-ink-muted" role="status">
        还没有用户组
      </p>
      <div v-else :class="[tableClasses.wrapper, 'overflow-hidden']">
        <table :class="[tableClasses.table, 'table-fixed']">
          <!-- Fixed widths so the layout holds steady across reloads; 角色 wraps if long. -->
          <colgroup>
            <col class="w-40" />
            <col />
            <col class="w-20" />
            <col class="w-28" />
          </colgroup>
          <thead :class="tableClasses.thead">
            <tr>
              <th scope="col" class="px-3 py-2">名称</th>
              <th scope="col" class="px-3 py-2">角色</th>
              <th scope="col" class="px-3 py-2">成员</th>
              <th scope="col" class="py-2 pr-6 pl-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="group in groups"
              :key="group.id"
              :class="tableClasses.row"
            >
              <td class="truncate px-3 py-2 text-ink">{{ group.name }}</td>
              <td class="truncate px-3 py-2 text-ink-muted">
                {{ group.roleIds.map(roleName).join("、") || "—" }}
              </td>
              <td class="px-3 py-2 text-ink-muted tabular-nums">
                {{ group.memberUsernames.length }} 人
              </td>
              <td class="px-3 py-2">
                <span class="flex justify-end gap-2">
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
    </template>

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
                还没定义角色，请先到「角色」标签新建一个角色再来
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
