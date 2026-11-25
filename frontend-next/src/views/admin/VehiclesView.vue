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
import UiHelpTip from "@/components/ui/UiHelpTip.vue";
import { FIELD_HELP } from "@/lib/fieldHelp";
import { computed, onMounted, ref, nextTick, watch } from "vue";
import { useDirtySnapshot } from "@/composables/useDirtySnapshot";
import { fleetApi } from "@navfleet/fleet-core";
import type { DeviceConfig } from "@navfleet/shared";
import PageHeader from "@/components/PageHeader.vue";
import UiLoading from "@/components/ui/UiLoading.vue";
import UiBusyRegion from "@/components/ui/UiBusyRegion.vue";
import AppSectionTabs from "@/components/shell/AppSectionTabs.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";
import UiModal from "@/components/ui/UiModal.vue";
import { tableClasses, textClasses } from "@/lib/uiClasses";
import { vOverflowTitle } from "@/directives/overflowTitle";
import { makeMessageFor } from "@/lib/errorMessages";
import { notify } from "@/composables/useNotifications";
import { useFieldErrors } from "@/composables/useFieldErrors";
import { loadDefaultSceneOptions } from "@/lib/sceneOptions";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_vehicles: "设备配置不合法，请检查各字段",
  unknown_scene_in_vehicle: "默认场景不存在，请重新选择",
  forbidden: "当前账号没有编辑设备的权限",
};
const messageFor = makeMessageFor(ERROR_MESSAGES);

const status = ref<"loading" | "ready" | "error">("loading");
/** A re-query of data already on screen (see `UiBusyRegion`); the first load is `status`. */
const refreshing = ref(false);
const vehicles = ref<DeviceConfig[]>([]);
const sceneOptions = ref<{ value: string; label: string }[]>([]);

const load = async (): Promise<void> => {
  if (status.value === "ready") refreshing.value = true;
  else status.value = "loading";
  try {
    const v = await fleetApi.getVehicleConfig();
    vehicles.value = v.vehicles;
    sceneOptions.value = await loadDefaultSceneOptions();
    refreshing.value = false;
    status.value = "ready";
  } catch {
    refreshing.value = false;
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
// Identity / spec metadata (optional, VDA 5050 factsheet-style; display-only).
const fVendor = ref("");
const fModel = ref("");
const fSerialNumber = ref("");
const fCategory = ref("");
const fMaxLoadKg = ref("");
const fCommissionedAt = ref("");
const fNotes = ref("");
// Clear a field's red state as soon as the operator starts fixing it.
clearOn(fDeviceId, "deviceId");
clearOn(fDeviceName, "deviceName");
clearOn(fMaxLoadKg, "maxLoadKg");

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
  fVendor.value = "";
  fModel.value = "";
  fSerialNumber.value = "";
  fCategory.value = "";
  fMaxLoadKg.value = "";
  fCommissionedAt.value = "";
  fNotes.value = "";
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
  fVendor.value = vehicle.vendor ?? "";
  fModel.value = vehicle.model ?? "";
  fSerialNumber.value = vehicle.serialNumber ?? "";
  fCategory.value = vehicle.category ?? "";
  fMaxLoadKg.value =
    vehicle.maxLoadKg === undefined ? "" : String(vehicle.maxLoadKg);
  fCommissionedAt.value = vehicle.commissionedAt ?? "";
  fNotes.value = vehicle.notes ?? "";
};
const close = (): void => {
  mode.value = null;
};

const buildVehicle = (): DeviceConfig => {
  const trimmed = (value: string): string | undefined =>
    value.trim() ? value.trim() : undefined;
  return {
    deviceId: fDeviceId.value.trim(),
    deviceName: fDeviceName.value.trim() || fDeviceId.value.trim(),
    defaultSceneId: fSceneId.value || undefined,
    gpsEnabled: fGps.value,
    rosMapEnabled: fRosMap.value,
    tags: fTags.value
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0),
    vendor: trimmed(fVendor.value),
    model: trimmed(fModel.value),
    serialNumber: trimmed(fSerialNumber.value),
    category: trimmed(fCategory.value),
    maxLoadKg: fMaxLoadKg.value.trim() ? Number(fMaxLoadKg.value) : undefined,
    commissionedAt: trimmed(fCommissionedAt.value),
    notes: trimmed(fNotes.value),
  };
};

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
  const loadRaw = fMaxLoadKg.value.trim();
  if (loadRaw && (!Number.isFinite(Number(loadRaw)) || Number(loadRaw) < 0)) {
    fieldErrors.maxLoadKg = "额定载重需为不小于 0 的数字";
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
    notify(mode.value === "create" ? "已新增设备" : "已更新设备", {
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
  mode.value === "create" ? "新增设备" : "编辑设备",
);

// Unsaved-changes guard for the dialog: snapshot the form once it is filled, so Esc / a backdrop
// click asks before discarding edits (see UiModal `dirty`).
const formSnapshot = useDirtySnapshot(() => [
  fDeviceId.value,
  fDeviceName.value,
  fSceneId.value,
  fTags.value,
  fGps.value,
  fRosMap.value,
  fVendor.value,
  fModel.value,
  fSerialNumber.value,
  fCategory.value,
  fMaxLoadKg.value,
  fCommissionedAt.value,
  fNotes.value,
]);
watch(
  () => mode.value !== null,
  (isOpen) => {
    if (isOpen) void nextTick(formSnapshot.mark);
  },
);
const formDirty = formSnapshot.dirty;
</script>

<template>
  <PageHeader title="部署">
    <template #actions>
      <UiButton size="sm" :disabled="status !== 'ready'" @click="openCreate"
        >新增设备</UiButton
      >
    </template>

    <AppSectionTabs />

    <UiLoading
      v-if="status === 'loading'"
      label="正在加载设备配置"
      :columns="6"
      action
    />
    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="alert"
    >
      无法加载设备配置
    </p>

    <UiBusyRegion v-else :busy="refreshing" content-class="flex flex-col gap-4">
      <p class="m-0 text-xs text-ink-subtle">{{ countLabel }}</p>
      <div :class="tableClasses.wrapper">
        <table :class="[tableClasses.table, 'table-fixed', 'min-w-[46rem]']">
          <!-- Shared column-width standard (`tableClasses`): bases are measured content widths,
               slack spread proportionally; long names/tags truncate. -->
          <colgroup>
            <col class="w-24" />
            <col class="w-32" />
            <col class="w-36" />
            <col class="w-36" />
            <col class="w-24" />
            <col class="w-32" />
          </colgroup>
          <thead :class="tableClasses.thead">
            <tr>
              <th scope="col" class="px-3 py-2">设备 ID</th>
              <th scope="col" class="px-3 py-2">名称</th>
              <th scope="col" class="px-3 py-2">默认场景</th>
              <th scope="col" class="px-3 py-2">标签</th>
              <th scope="col" class="px-3 py-2">GPS / ROS</th>
              <th scope="col" class="py-2 pr-6 pl-3 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="vehicles.length === 0">
              <td colspan="6" class="px-3 py-3 text-sm text-ink-muted">
                暂无设备配置；新增后，对应设备上报时即套用这些覆盖项
              </td>
            </tr>
            <tr
              v-for="vehicle in vehicles"
              :key="vehicle.deviceId"
              :class="tableClasses.row"
            >
              <th
                v-overflow-title
                scope="row"
                class="px-3 py-2 font-mono text-2xs text-ink"
                :class="textClasses.cell"
              >
                {{ vehicle.deviceId }}
              </th>
              <td
                v-overflow-title
                class="px-3 py-2 text-ink-muted"
                :class="textClasses.cell"
              >
                {{ vehicle.deviceName }}
              </td>
              <td
                v-overflow-title
                class="px-3 py-2 text-ink-muted"
                :class="textClasses.cell"
              >
                {{ vehicle.defaultSceneId || "—" }}
              </td>
              <td
                v-overflow-title
                class="px-3 py-2 text-ink-muted"
                :class="textClasses.cell"
              >
                {{ (vehicle.tags ?? []).join("、") || "—" }}
              </td>
              <td class="px-3 py-2 text-ink-muted">
                {{ vehicle.gpsEnabled === false ? "—" : "GPS" }} /
                {{ vehicle.rosMapEnabled === false ? "—" : "ROS" }}
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
    </UiBusyRegion>
  </PageHeader>

  <!-- Vehicle create/edit -->
  <UiModal
    :pending="saving"
    :open="mode !== null"
    :dirty="formDirty"
    :autofocus="mode === 'create'"
    :title="dialogTitle"
    description="填写设备配置后提交"
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
        <span class="flex items-center gap-1"
          ><span class="text-sm font-medium text-ink"
            >设备 ID <span class="text-critical-ink">*</span></span
          ><UiHelpTip :text="FIELD_HELP.vehicle.deviceId"
        /></span>
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
        <span class="flex items-center gap-1"
          ><span class="text-sm font-medium text-ink">默认场景</span
          ><UiHelpTip :text="FIELD_HELP.vehicle.defaultScene"
        /></span>
        <UiSelect
          v-model="fSceneId"
          :options="sceneOptions"
          aria-label="默认场景"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="flex items-center gap-1"
          ><span class="text-sm font-medium text-ink">标签</span
          ><UiHelpTip :text="FIELD_HELP.vehicle.tags"
        /></span>
        <UiInput
          v-model="fTags"
          type="text"
          placeholder="逗号分隔"
          :disabled="saving"
          size="sm"
        />
      </label>
      <div class="grid grid-cols-2 gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink">厂商</span>
          <UiInput v-model="fVendor" type="text" :disabled="saving" size="sm" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink">型号</span>
          <UiInput v-model="fModel" type="text" :disabled="saving" size="sm" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink">序列号</span>
          <UiInput
            v-model="fSerialNumber"
            type="text"
            :disabled="saving"
            size="sm"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink">类型</span>
          <UiInput
            v-model="fCategory"
            type="text"
            placeholder="如 巡检 / 搬运 / 牵引"
            :disabled="saving"
            size="sm"
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="flex items-center gap-1"
            ><span class="text-sm font-medium text-ink">额定载重（kg）</span
            ><UiHelpTip :text="FIELD_HELP.vehicle.maxLoadKg"
          /></span>
          <UiInput
            v-model="fMaxLoadKg"
            type="number"
            min="0"
            :disabled="saving"
            :invalid="!!errors.maxLoadKg"
            size="sm"
          />
          <p v-if="errors.maxLoadKg" class="m-0 text-xs text-critical-ink">
            {{ errors.maxLoadKg }}
          </p>
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium text-ink">投产日期</span>
          <UiInput
            v-model="fCommissionedAt"
            type="date"
            :disabled="saving"
            size="sm"
          />
        </label>
      </div>
      <label class="flex flex-col gap-1">
        <span class="text-sm font-medium text-ink">备注</span>
        <UiInput v-model="fNotes" type="text" :disabled="saving" size="sm" />
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
    :title="`删除设备配置 ${confirmDelete?.label ?? ''}？`"
    description="仅移除配置覆盖；已上报的设备快照不受影响；仍被编队引用时会被拒绝"
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
