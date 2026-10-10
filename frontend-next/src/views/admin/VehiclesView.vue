<script setup lang="ts">
/**
 * 部署 / 车辆 — the vehicle-override editor (admin; split out of the 设备接入 onboarding page in
 * 1.6.2). Turns hand-editing `config-runtime/vehicles.json` on the server into a UI operation:
 * edit → validate → PUT → the backend writes atomically and hot-reloads. Writing config is
 * operator-domain, **not** vehicle control — the read-only red line (no command dispatch) holds.
 *
 * `vehicles.json` is a set of **overrides**, not device creation: a configured device still only
 * appears in monitoring once it reports. The whole array is read-modify-written (like the codebook
 * import), and the backend re-validates as the authority. A vehicle still referenced by a 编队 is
 * refused deletion — the 编队 tab is where that link is managed.
 */
import { computed, onMounted, ref } from "vue";
import { fleetApi } from "@navfleet/fleet-core";
import type { DeviceConfig } from "@navfleet/shared";
import PageHeader from "@/components/PageHeader.vue";
import AppSectionTabs from "@/components/shell/AppSectionTabs.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";
import UiModal from "@/components/ui/UiModal.vue";
import { tableClasses } from "@/lib/uiClasses";
import { makeMessageFor } from "@/lib/errorMessages";
import { notify } from "@/composables/useNotifications";
import { useFieldErrors } from "@/composables/useFieldErrors";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_vehicles: "车辆配置不合法，请检查各字段",
  vehicle_referenced_by_formation: "该车辆仍被某个编队引用，请先从编队移除",
  forbidden: "需要管理员权限",
};
const messageFor = makeMessageFor(ERROR_MESSAGES);

const status = ref<"loading" | "ready" | "error">("loading");
const vehicles = ref<DeviceConfig[]>([]);
const sceneOptions = ref<{ value: string; label: string }[]>([]);

const load = async (): Promise<void> => {
  status.value = "loading";
  try {
    const v = await fleetApi.getVehicleConfig();
    vehicles.value = v.vehicles;
    // Scenes only populate a dropdown; a failure there must not fail the whole page.
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

const countLabel = computed(() =>
  vehicles.value.length ? `共 ${vehicles.value.length} 条记录` : "",
);

// ── Create / edit ────────────────────────────────────────────────────────────
type Mode = "create" | "edit" | null;
const mode = ref<Mode>(null);
const saving = ref(false);
const formError = ref("");
const { errors, clearOn, setErrors, report } = useFieldErrors();
const editingId = ref("");
const fDeviceId = ref("");
const fDeviceName = ref("");
const fSceneId = ref("");
const fTags = ref("");
const fGps = ref(true);
const fRosMap = ref(true);
// Clear a field's red state as soon as the operator starts fixing it.
clearOn(fDeviceId, "deviceId");
clearOn(fDeviceName, "deviceName");

const openCreate = (): void => {
  mode.value = "create";
  formError.value = "";
  setErrors({});
  editingId.value = "";
  fDeviceId.value = "";
  fDeviceName.value = "";
  fSceneId.value = "";
  fTags.value = "";
  fGps.value = true;
  fRosMap.value = true;
};
const openEdit = (vehicle: DeviceConfig): void => {
  mode.value = "edit";
  formError.value = "";
  setErrors({});
  editingId.value = vehicle.deviceId;
  fDeviceId.value = vehicle.deviceId;
  fDeviceName.value = vehicle.deviceName ?? "";
  fSceneId.value = vehicle.defaultSceneId ?? "";
  fTags.value = (vehicle.tags ?? []).join(", ");
  fGps.value = vehicle.gpsEnabled ?? true;
  fRosMap.value = vehicle.rosMapEnabled ?? true;
};
const close = (): void => {
  mode.value = null;
};

const buildVehicle = (): DeviceConfig => ({
  deviceId: fDeviceId.value.trim(),
  deviceName: fDeviceName.value.trim() || fDeviceId.value.trim(),
  defaultSceneId: fSceneId.value || undefined,
  gpsEnabled: fGps.value,
  rosMapEnabled: fRosMap.value,
  tags: fTags.value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0),
});

const persist = async (next: DeviceConfig[]): Promise<boolean> => {
  try {
    const result = await fleetApi.putVehicleConfig(next);
    vehicles.value = result.vehicles;
    return true;
  } catch (error) {
    formError.value = messageFor(error);
    notify(messageFor(error), { type: "error" });
    return false;
  }
};

const submit = async (): Promise<void> => {
  formError.value = "";
  const id = fDeviceId.value.trim();
  const fieldErrors: Record<string, string> = {};
  if (!id) {
    fieldErrors.deviceId = "请输入设备 ID";
  } else if (
    mode.value === "create" &&
    vehicles.value.some((v) => v.deviceId === id)
  ) {
    fieldErrors.deviceId = "设备 ID 已存在";
  }
  if (!fDeviceName.value.trim()) {
    fieldErrors.deviceName = "请输入名称";
  }
  if (report(fieldErrors)) return;
  saving.value = true;
  const entry = buildVehicle();
  const next =
    mode.value === "edit"
      ? vehicles.value.map((v) => (v.deviceId === editingId.value ? entry : v))
      : [...vehicles.value, entry];
  const ok = await persist(next);
  saving.value = false;
  if (ok) {
    notify(mode.value === "create" ? "已新增车辆" : "已更新车辆", {
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
    vehicles.value.filter((v) => v.deviceId !== target.id),
  );
  deleting.value = false;
  if (ok) {
    notify("已删除", { type: "success" });
    confirmDelete.value = null;
  }
};

const dialogTitle = computed(() =>
  mode.value === "create" ? "新增车辆" : "编辑车辆",
);
</script>

<template>
  <PageHeader title="部署">
    <template #actions>
      <UiButton size="sm" :disabled="status !== 'ready'" @click="openCreate"
        >新增车辆</UiButton
      >
    </template>

    <AppSectionTabs />

    <p v-if="status === 'loading'" class="text-sm text-ink-muted">加载中…</p>
    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="alert"
    >
      无法加载车辆配置
    </p>

    <template v-else>
      <p class="m-0 text-xs text-ink-subtle">{{ countLabel }}</p>
      <div :class="[tableClasses.wrapper, 'overflow-auto']">
        <table :class="[tableClasses.table, 'table-fixed']">
          <!-- Fixed widths, every column pinned (none width-less) so a wide table grows the columns
               proportionally and evenly — modelled on the device list; long names/tags truncate. -->
          <colgroup>
            <col class="w-32" />
            <col class="w-36" />
            <col class="w-36" />
            <col class="w-48" />
            <col class="w-32" />
            <col class="w-28" />
          </colgroup>
          <thead :class="tableClasses.thead">
            <tr>
              <th scope="col" class="px-3 py-2">设备 ID</th>
              <th scope="col" class="px-3 py-2">名称</th>
              <th scope="col" class="px-3 py-2">默认场景</th>
              <th scope="col" class="px-3 py-2">标签</th>
              <th scope="col" class="px-3 py-2">GPS / 场景图</th>
              <th scope="col" class="py-2 pr-6 pl-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="vehicles.length === 0">
              <td colspan="6" class="px-3 py-3 text-sm text-ink-muted">
                暂无车辆配置；新增后，对应车辆上报时即套用这些覆盖项
              </td>
            </tr>
            <tr
              v-for="vehicle in vehicles"
              :key="vehicle.deviceId"
              :class="tableClasses.row"
            >
              <th
                scope="row"
                class="truncate px-3 py-2 font-mono text-2xs text-ink"
              >
                {{ vehicle.deviceId }}
              </th>
              <td class="truncate px-3 py-2 text-ink-muted">
                {{ vehicle.deviceName }}
              </td>
              <td class="truncate px-3 py-2 text-ink-muted">
                {{ vehicle.defaultSceneId || "—" }}
              </td>
              <td class="truncate px-3 py-2 text-ink-muted">
                {{ (vehicle.tags ?? []).join("、") || "—" }}
              </td>
              <td class="px-3 py-2 text-ink-muted">
                {{ vehicle.gpsEnabled === false ? "—" : "GPS" }} /
                {{ vehicle.rosMapEnabled === false ? "—" : "场景图" }}
              </td>
              <td class="px-3 py-2">
                <div class="flex justify-end gap-1">
                  <UiButton variant="ghost" size="sm" @click="openEdit(vehicle)"
                    >编辑</UiButton
                  >
                  <UiButton
                    variant="ghost"
                    size="sm"
                    @click="
                      confirmDelete = {
                        id: vehicle.deviceId,
                        label: vehicle.deviceName || vehicle.deviceId,
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

  <!-- Vehicle create/edit -->
  <UiModal
    :open="mode !== null"
    :autofocus="mode === 'create'"
    :title="dialogTitle"
    description="填写车辆配置后提交"
    @update:open="
      (o) => {
        if (!o) close();
      }
    "
  >
    <form
      class="flex flex-col gap-3"
      :aria-busy="saving"
      @submit.prevent="submit"
    >
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium text-ink"
          >设备 ID <span class="text-critical-ink">*</span></span
        >
        <UiInput
          v-model="fDeviceId"
          type="text"
          :disabled="mode === 'edit' || saving"
          :invalid="!!errors.deviceId"
          size="sm"
        />
        <p v-if="errors.deviceId" class="m-0 text-xs text-critical-ink">
          {{ errors.deviceId }}
        </p>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium text-ink"
          >名称 <span class="text-critical-ink">*</span></span
        >
        <UiInput
          v-model="fDeviceName"
          type="text"
          :disabled="saving"
          :invalid="!!errors.deviceName"
          size="sm"
        />
        <p v-if="errors.deviceName" class="m-0 text-xs text-critical-ink">
          {{ errors.deviceName }}
        </p>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium text-ink">默认场景</span>
        <UiSelect
          v-model="fSceneId"
          :options="sceneOptions"
          aria-label="默认场景"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium text-ink">标签</span>
        <UiInput
          v-model="fTags"
          type="text"
          placeholder="逗号分隔"
          :disabled="saving"
          size="sm"
        />
      </label>
      <label class="flex items-center gap-2">
        <input v-model="fGps" type="checkbox" :disabled="saving" />
        <span class="text-sm text-ink">在 GPS 地图中显示</span>
      </label>
      <label class="flex items-center gap-2">
        <input v-model="fRosMap" type="checkbox" :disabled="saving" />
        <span class="text-sm text-ink">在 ROS 地图中显示</span>
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
  </UiModal>

  <UiConfirmDialog
    :open="confirmDelete !== null"
    :title="`删除车辆配置 ${confirmDelete?.label ?? ''}？`"
    description="仅移除配置覆盖；已上报的车辆快照不受影响；仍被编队引用时会被拒绝"
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
