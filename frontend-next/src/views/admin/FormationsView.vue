<script setup lang="ts">
/**
 * 部署 / 编队 — the formation editor (admin; split out of the 设备接入 onboarding page in 1.6.2).
 * A formation binds a set of configured vehicles under one id; the console reads `formations.json`
 * and writes the whole array back (edit → validate → PUT → atomic write + hot-reload). Writing
 * config is operator-domain, not vehicle control — the read-only red line holds.
 *
 * It reads the vehicle list to populate the member picker, and the backend enforces
 * formation→vehicle referential integrity (a formation cannot reference an unconfigured vehicle);
 * the picker only offers configured vehicles, so the UI guards it up front too.
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
import { fleetApi } from "@navfleet/fleet-core";
import type { DeviceConfig, FormationConfig } from "@navfleet/shared";
import PageHeader from "@/components/PageHeader.vue";
import AppSectionTabs from "@/components/shell/AppSectionTabs.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";
import { tableClasses } from "@/lib/uiClasses";
import { notify } from "@/composables/useNotifications";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_formations: "编队配置不合法，请检查各字段",
  unknown_device_in_formation: "编队引用了未配置的车辆",
  forbidden: "需要管理员权限",
};
const messageFor = (error: unknown): string => {
  const code = error instanceof Error ? error.message : "";
  return ERROR_MESSAGES[code] ?? "保存失败，请稍后重试";
};

const INPUT_CLASS =
  "h-9 rounded-sm border border-border-strong bg-surface px-2 text-sm text-ink placeholder:text-ink-subtle";

const status = ref<"loading" | "ready" | "error">("loading");
const vehicles = ref<DeviceConfig[]>([]);
const formations = ref<FormationConfig[]>([]);
const sceneOptions = ref<{ value: string; label: string }[]>([]);

const load = async (): Promise<void> => {
  status.value = "loading";
  try {
    const [v, f] = await Promise.all([
      fleetApi.getVehicleConfig(),
      fleetApi.getFormationConfig(),
    ]);
    vehicles.value = v.vehicles;
    formations.value = f.formations;
    let sceneItems: { sceneId: string; sceneName?: string }[] = [];
    try {
      sceneItems = (await fleetApi.getScenes()).items ?? [];
    } catch {
      sceneItems = [];
    }
    sceneOptions.value = [
      { value: "", label: "（不设默认场景）" },
      ...sceneItems.map((scene) => ({
        value: scene.sceneId,
        label: scene.sceneName || scene.sceneId,
      })),
    ];
    status.value = "ready";
  } catch {
    status.value = "error";
  }
};
onMounted(() => void load());

const vehicleOptions = computed(() =>
  vehicles.value.map((vehicle) => ({
    value: vehicle.deviceId,
    label: vehicle.deviceName || vehicle.deviceId,
  })),
);
const countLabel = computed(() =>
  formations.value.length ? `共 ${formations.value.length} 条记录` : "",
);

// ── Create / edit ────────────────────────────────────────────────────────────
type Mode = "create" | "edit" | null;
const mode = ref<Mode>(null);
const saving = ref(false);
const formError = ref("");
const editingId = ref("");
const fId = ref("");
const fName = ref("");
const fDeviceIds = ref<string[]>([]);
const fSceneId = ref("");
const fDescription = ref("");
const fColor = ref("");

const openCreate = (): void => {
  mode.value = "create";
  formError.value = "";
  editingId.value = "";
  fId.value = "";
  fName.value = "";
  fDeviceIds.value = [];
  fSceneId.value = "";
  fDescription.value = "";
  fColor.value = "";
};
const openEdit = (formation: FormationConfig): void => {
  mode.value = "edit";
  formError.value = "";
  editingId.value = formation.formationId;
  fId.value = formation.formationId;
  fName.value = formation.formationName ?? "";
  fDeviceIds.value = [...formation.deviceIds];
  fSceneId.value = formation.sceneId ?? "";
  fDescription.value = formation.description ?? "";
  fColor.value = formation.color ?? "";
};
const close = (): void => {
  mode.value = null;
};
const toggleDevice = (deviceId: string): void => {
  fDeviceIds.value = fDeviceIds.value.includes(deviceId)
    ? fDeviceIds.value.filter((id) => id !== deviceId)
    : [...fDeviceIds.value, deviceId];
};

const persist = async (next: FormationConfig[]): Promise<boolean> => {
  try {
    const result = await fleetApi.putFormationConfig(next);
    formations.value = result.formations;
    return true;
  } catch (error) {
    formError.value = messageFor(error);
    notify(messageFor(error), { type: "error" });
    return false;
  }
};

const submit = async (): Promise<void> => {
  formError.value = "";
  const id = fId.value.trim();
  if (!id) {
    formError.value = "请输入编队 ID";
    return;
  }
  if (
    mode.value === "create" &&
    formations.value.some((f) => f.formationId === id)
  ) {
    formError.value = "编队 ID 已存在";
    return;
  }
  if (fDeviceIds.value.length === 0) {
    formError.value = "请至少选择一台车辆";
    return;
  }
  saving.value = true;
  const entry: FormationConfig = {
    formationId: id,
    formationName: fName.value.trim() || id,
    deviceIds: [...fDeviceIds.value],
    sceneId: fSceneId.value || undefined,
    description: fDescription.value.trim() || undefined,
    color: fColor.value.trim() || undefined,
  };
  const next =
    mode.value === "edit"
      ? formations.value.map((f) =>
          f.formationId === editingId.value ? entry : f,
        )
      : [...formations.value, entry];
  const ok = await persist(next);
  saving.value = false;
  if (ok) {
    notify(mode.value === "create" ? "已新增编队" : "已更新编队", {
      type: "success",
    });
    mode.value = null;
  }
};

// ── Delete (confirm) ───────────────────────────────────────────────────────────
const confirmDelete = ref<{ id: string; label: string } | null>(null);
const deleting = ref(false);
const runDelete = async (): Promise<void> => {
  const target = confirmDelete.value;
  if (!target) return;
  deleting.value = true;
  const ok = await persist(
    formations.value.filter((f) => f.formationId !== target.id),
  );
  deleting.value = false;
  if (ok) {
    notify("已删除", { type: "success" });
    confirmDelete.value = null;
  }
};

const dialogTitle = computed(() =>
  mode.value === "create" ? "新增编队" : "编辑编队",
);
</script>

<template>
  <PageHeader title="部署">
    <template #actions>
      <UiButton
        size="sm"
        :disabled="status !== 'ready' || vehicles.length === 0"
        @click="openCreate"
        >新增编队</UiButton
      >
    </template>

    <AppSectionTabs />

    <p v-if="status === 'loading'" class="text-sm text-ink-muted">加载中…</p>
    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="alert"
    >
      无法加载编队配置
    </p>

    <template v-else>
      <p class="m-0 text-xs text-ink-subtle">{{ countLabel }}</p>
      <div :class="[tableClasses.wrapper, 'overflow-auto']">
        <table :class="[tableClasses.table, 'table-fixed']">
          <!-- Fixed widths, every column pinned (none width-less) so the columns grow evenly on a
               wide table — modelled on the device list; long names truncate. -->
          <colgroup>
            <col class="w-32" />
            <col class="w-40" />
            <col class="w-20" />
            <col class="w-36" />
            <col class="w-28" />
          </colgroup>
          <thead :class="tableClasses.thead">
            <tr>
              <th scope="col" class="px-3 py-2">编队 ID</th>
              <th scope="col" class="px-3 py-2">名称</th>
              <th scope="col" class="px-3 py-2">车辆</th>
              <th scope="col" class="px-3 py-2">场景</th>
              <th scope="col" class="py-2 pr-6 pl-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="formations.length === 0">
              <td colspan="5" class="px-3 py-3 text-sm text-ink-muted">
                暂无编队配置
              </td>
            </tr>
            <tr
              v-for="formation in formations"
              :key="formation.formationId"
              :class="tableClasses.row"
            >
              <th
                scope="row"
                class="truncate px-3 py-2 font-mono text-2xs text-ink"
              >
                {{ formation.formationId }}
              </th>
              <td class="truncate px-3 py-2 text-ink-muted">
                {{ formation.formationName }}
              </td>
              <td class="px-3 py-2 text-ink-muted">
                {{ formation.deviceIds.length }} 台
              </td>
              <td class="truncate px-3 py-2 text-ink-muted">
                {{ formation.sceneId || "—" }}
              </td>
              <td class="px-3 py-2">
                <div class="flex justify-end gap-1">
                  <UiButton
                    variant="ghost"
                    size="sm"
                    @click="openEdit(formation)"
                    >编辑</UiButton
                  >
                  <UiButton
                    variant="ghost"
                    size="sm"
                    @click="
                      confirmDelete = {
                        id: formation.formationId,
                        label: formation.formationName || formation.formationId,
                      }
                    "
                  >
                    删除
                  </UiButton>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </PageHeader>

  <!-- Formation create/edit -->
  <DialogRoot
    :open="mode !== null"
    @update:open="
      (o) => {
        if (!o) close();
      }
    "
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-scrim/55" />
      <DialogContent
        class="fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-full max-w-100 -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-auto rounded-md border border-border bg-surface-raised p-5 shadow-overlay"
      >
        <DialogTitle class="text-md font-semibold text-ink">{{
          dialogTitle
        }}</DialogTitle>
        <DialogDescription class="sr-only"
          >填写编队配置后提交</DialogDescription
        >
        <form
          class="flex flex-col gap-3"
          :aria-busy="saving"
          @submit.prevent="submit"
        >
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">编队 ID</span>
            <input
              v-model="fId"
              type="text"
              :disabled="mode === 'edit' || saving"
              :class="INPUT_CLASS"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">名称</span>
            <input
              v-model="fName"
              type="text"
              :disabled="saving"
              :class="INPUT_CLASS"
            />
          </label>
          <fieldset class="flex flex-col gap-1">
            <legend class="text-sm font-medium text-ink">
              车辆（至少一台）
            </legend>
            <div
              class="flex max-h-40 flex-col gap-1 overflow-auto rounded-sm border border-border p-2"
            >
              <label
                v-for="option in vehicleOptions"
                :key="option.value"
                class="flex items-center gap-2"
              >
                <input
                  type="checkbox"
                  :checked="fDeviceIds.includes(option.value)"
                  :disabled="saving"
                  @change="toggleDevice(option.value)"
                />
                <span class="text-sm text-ink">{{ option.label }}</span>
              </label>
            </div>
          </fieldset>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">默认场景</span>
            <UiSelect
              v-model="fSceneId"
              :options="sceneOptions"
              aria-label="编队默认场景"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">描述</span>
            <input
              v-model="fDescription"
              type="text"
              :disabled="saving"
              :class="INPUT_CLASS"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink"
              >颜色（可选，如 #46d7c3）</span
            >
            <input
              v-model="fColor"
              type="text"
              :disabled="saving"
              :class="INPUT_CLASS"
            />
          </label>
          <p v-if="formError" class="text-sm text-critical-ink" role="alert">
            {{ formError }}
          </p>
          <div class="mt-1 flex justify-end gap-2">
            <UiButton
              variant="secondary"
              size="sm"
              :disabled="saving"
              @click="close"
              >取消</UiButton
            >
            <UiButton type="submit" size="sm" :disabled="saving">
              {{ saving ? "提交中…" : "保存" }}
            </UiButton>
          </div>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>

  <UiConfirmDialog
    :open="confirmDelete !== null"
    :title="`删除编队 ${confirmDelete?.label ?? ''}？`"
    description="移除该编队配置，不影响其中车辆本身"
    confirm-label="删除"
    :pending="deleting"
    @update:open="
      (o) => {
        if (!o) confirmDelete = null;
      }
    "
    @confirm="runDelete"
  />
</template>
