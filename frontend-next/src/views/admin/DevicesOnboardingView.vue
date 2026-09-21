<script setup lang="ts">
/**
 * 设备接入 — the onboarding wizard (admin). Turns hand-editing `config-runtime/vehicles.json`
 * and `formations.json` on the server into a UI operation: edit → validate → PUT → the backend
 * writes atomically and hot-reloads. Writing config is operator-domain, **not** vehicle control
 * — the read-only red line (no command dispatch) holds; this extends the codebook-import
 * precedent (Phase 16C).
 *
 * `vehicles.json` is a set of **overrides**, not device creation: a configured device still only
 * appears in monitoring once it reports. The page says so. Both files are read-modify-write of
 * the whole array (like the codebook import), and the backend re-validates as the authority —
 * including formation→vehicle referential integrity, which the UI also guards up front.
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
import UiButton from "@/components/ui/UiButton.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";
import { tableClasses } from "@/lib/uiClasses";
import { notify } from "@/composables/useNotifications";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_vehicles: "车辆配置不合法，请检查各字段",
  invalid_formations: "编队配置不合法，请检查各字段",
  unknown_device_in_formation: "编队引用了未配置的车辆",
  vehicle_referenced_by_formation: "该车辆仍被某个编队引用，请先从编队移除",
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

const vehicleOptions = computed(() =>
  vehicles.value.map((vehicle) => ({
    value: vehicle.deviceId,
    label: vehicle.deviceName || vehicle.deviceId,
  })),
);

// ── Vehicle create/edit ─────────────────────────────────────────────────────
type Mode = "create" | "edit" | null;
const vMode = ref<Mode>(null);
const vSaving = ref(false);
const vError = ref("");
const vEditingId = ref(""); // the deviceId being edited (create uses fDeviceId)
const fDeviceId = ref("");
const fDeviceName = ref("");
const fSceneId = ref("");
const fTags = ref("");
const fGps = ref(true);
const fRosMap = ref(true);

const openVehicleCreate = (): void => {
  vMode.value = "create";
  vError.value = "";
  vEditingId.value = "";
  fDeviceId.value = "";
  fDeviceName.value = "";
  fSceneId.value = "";
  fTags.value = "";
  fGps.value = true;
  fRosMap.value = true;
};
const openVehicleEdit = (vehicle: DeviceConfig): void => {
  vMode.value = "edit";
  vError.value = "";
  vEditingId.value = vehicle.deviceId;
  fDeviceId.value = vehicle.deviceId;
  fDeviceName.value = vehicle.deviceName ?? "";
  fSceneId.value = vehicle.defaultSceneId ?? "";
  fTags.value = (vehicle.tags ?? []).join(", ");
  fGps.value = vehicle.gpsEnabled ?? true;
  fRosMap.value = vehicle.rosMapEnabled ?? true;
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

const persistVehicles = async (next: DeviceConfig[]): Promise<boolean> => {
  try {
    const result = await fleetApi.putVehicleConfig(next);
    vehicles.value = result.vehicles;
    return true;
  } catch (error) {
    vError.value = messageFor(error);
    notify(messageFor(error), { type: "error" });
    return false;
  }
};

const submitVehicle = async (): Promise<void> => {
  vError.value = "";
  const id = fDeviceId.value.trim();
  if (!id) {
    vError.value = "请输入设备 ID";
    return;
  }
  if (
    vMode.value === "create" &&
    vehicles.value.some((v) => v.deviceId === id)
  ) {
    vError.value = "设备 ID 已存在";
    return;
  }
  vSaving.value = true;
  const entry = buildVehicle();
  const next =
    vMode.value === "edit"
      ? vehicles.value.map((v) => (v.deviceId === vEditingId.value ? entry : v))
      : [...vehicles.value, entry];
  const ok = await persistVehicles(next);
  vSaving.value = false;
  if (ok) {
    notify(vMode.value === "create" ? "已新增车辆" : "已更新车辆", {
      type: "success",
    });
    vMode.value = null;
  }
};

// ── Formation create/edit ───────────────────────────────────────────────────
const gMode = ref<Mode>(null);
const gSaving = ref(false);
const gError = ref("");
const gEditingId = ref("");
const gFormationId = ref("");
const gFormationName = ref("");
const gDeviceIds = ref<string[]>([]);
const gSceneId = ref("");
const gDescription = ref("");
const gColor = ref("");

const openFormationCreate = (): void => {
  gMode.value = "create";
  gError.value = "";
  gEditingId.value = "";
  gFormationId.value = "";
  gFormationName.value = "";
  gDeviceIds.value = [];
  gSceneId.value = "";
  gDescription.value = "";
  gColor.value = "";
};
const openFormationEdit = (formation: FormationConfig): void => {
  gMode.value = "edit";
  gError.value = "";
  gEditingId.value = formation.formationId;
  gFormationId.value = formation.formationId;
  gFormationName.value = formation.formationName ?? "";
  gDeviceIds.value = [...formation.deviceIds];
  gSceneId.value = formation.sceneId ?? "";
  gDescription.value = formation.description ?? "";
  gColor.value = formation.color ?? "";
};

const toggleFormationDevice = (deviceId: string): void => {
  gDeviceIds.value = gDeviceIds.value.includes(deviceId)
    ? gDeviceIds.value.filter((id) => id !== deviceId)
    : [...gDeviceIds.value, deviceId];
};

const persistFormations = async (next: FormationConfig[]): Promise<boolean> => {
  try {
    const result = await fleetApi.putFormationConfig(next);
    formations.value = result.formations;
    return true;
  } catch (error) {
    gError.value = messageFor(error);
    notify(messageFor(error), { type: "error" });
    return false;
  }
};

const submitFormation = async (): Promise<void> => {
  gError.value = "";
  const id = gFormationId.value.trim();
  if (!id) {
    gError.value = "请输入编队 ID";
    return;
  }
  if (
    gMode.value === "create" &&
    formations.value.some((f) => f.formationId === id)
  ) {
    gError.value = "编队 ID 已存在";
    return;
  }
  if (gDeviceIds.value.length === 0) {
    gError.value = "请至少选择一台车辆";
    return;
  }
  gSaving.value = true;
  const entry: FormationConfig = {
    formationId: id,
    formationName: gFormationName.value.trim() || id,
    deviceIds: [...gDeviceIds.value],
    sceneId: gSceneId.value || undefined,
    description: gDescription.value.trim() || undefined,
    color: gColor.value.trim() || undefined,
  };
  const next =
    gMode.value === "edit"
      ? formations.value.map((f) =>
          f.formationId === gEditingId.value ? entry : f,
        )
      : [...formations.value, entry];
  const ok = await persistFormations(next);
  gSaving.value = false;
  if (ok) {
    notify(gMode.value === "create" ? "已新增编队" : "已更新编队", {
      type: "success",
    });
    gMode.value = null;
  }
};

// ── Delete (confirm) ────────────────────────────────────────────────────────
type Confirm =
  | { kind: "vehicle"; id: string; label: string }
  | { kind: "formation"; id: string; label: string };
const confirm = ref<Confirm | null>(null);
const deleting = ref(false);

const confirmCopy = computed(() => {
  const value = confirm.value;
  if (!value) return { title: "", description: "", label: "删除" };
  return value.kind === "vehicle"
    ? {
        title: `删除车辆配置 ${value.label}？`,
        description:
          "仅移除配置覆盖；已上报的车辆快照不受影响；仍被编队引用时会被拒绝",
        label: "删除",
      }
    : {
        title: `删除编队 ${value.label}？`,
        description: "移除该编队配置，不影响其中车辆本身",
        label: "删除",
      };
});

const runDelete = async (): Promise<void> => {
  const value = confirm.value;
  if (!value) return;
  deleting.value = true;
  const ok =
    value.kind === "vehicle"
      ? await persistVehicles(
          vehicles.value.filter((v) => v.deviceId !== value.id),
        )
      : await persistFormations(
          formations.value.filter((f) => f.formationId !== value.id),
        );
  deleting.value = false;
  if (ok) {
    notify("已删除", { type: "success" });
    confirm.value = null;
  }
};

const closeVehicle = (): void => {
  vMode.value = null;
};
const closeFormation = (): void => {
  gMode.value = null;
};
const vTitle = computed(() =>
  vMode.value === "create" ? "新增车辆" : "编辑车辆",
);
const gTitle = computed(() =>
  gMode.value === "create" ? "新增编队" : "编辑编队",
);
</script>

<template>
  <PageHeader title="设备接入">
    <p class="m-0 text-sm text-ink-muted">
      配置车辆与编队并写入 <code>vehicles.json</code> /
      <code>formations.json</code
      >（保存即热重载）；配的是<strong>覆盖项</strong>：车辆需上报后才出现在监控里，也仍可在宿主机手改这两个文件
    </p>

    <p v-if="status === 'loading'" class="mt-3 text-sm text-ink-muted">
      加载中…
    </p>
    <p
      v-else-if="status === 'error'"
      class="mt-3 text-sm text-critical-ink"
      role="alert"
    >
      无法加载配置
    </p>

    <template v-else>
      <section class="mt-4">
        <div class="mb-2 flex items-center gap-2">
          <h3 class="text-md font-semibold text-ink">
            车辆（{{ vehicles.length }}）
          </h3>
          <UiButton class="ml-auto" size="sm" @click="openVehicleCreate"
            >新增车辆</UiButton
          >
        </div>
        <div :class="[tableClasses.wrapper, 'overflow-auto']">
          <table :class="tableClasses.table">
            <thead :class="tableClasses.thead">
              <tr>
                <th scope="col" class="px-3 py-2">设备 ID</th>
                <th scope="col" class="px-3 py-2">名称</th>
                <th scope="col" class="px-3 py-2">默认场景</th>
                <th scope="col" class="px-3 py-2">标签</th>
                <th scope="col" class="px-3 py-2">GPS / 场景图</th>
                <th scope="col" class="px-3 py-2 text-right">操作</th>
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
                <th scope="row" class="px-3 py-2 font-mono text-2xs text-ink">
                  {{ vehicle.deviceId }}
                </th>
                <td class="px-3 py-2 text-ink-muted">
                  {{ vehicle.deviceName }}
                </td>
                <td class="px-3 py-2 text-ink-muted">
                  {{ vehicle.defaultSceneId || "—" }}
                </td>
                <td class="px-3 py-2 text-ink-muted">
                  {{ (vehicle.tags ?? []).join("、") || "—" }}
                </td>
                <td class="px-3 py-2 text-ink-muted">
                  {{ vehicle.gpsEnabled === false ? "—" : "GPS" }} /
                  {{ vehicle.rosMapEnabled === false ? "—" : "场景图" }}
                </td>
                <td class="px-3 py-2">
                  <div class="flex justify-end gap-1">
                    <UiButton
                      variant="ghost"
                      size="sm"
                      @click="openVehicleEdit(vehicle)"
                      >编辑</UiButton
                    >
                    <UiButton
                      variant="ghost"
                      size="sm"
                      @click="
                        confirm = {
                          kind: 'vehicle',
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
      </section>

      <section class="mt-6">
        <div class="mb-2 flex items-center gap-2">
          <h3 class="text-md font-semibold text-ink">
            编队（{{ formations.length }}）
          </h3>
          <UiButton
            class="ml-auto"
            size="sm"
            :disabled="vehicles.length === 0"
            @click="openFormationCreate"
            >新增编队</UiButton
          >
        </div>
        <div :class="[tableClasses.wrapper, 'overflow-auto']">
          <table :class="tableClasses.table">
            <thead :class="tableClasses.thead">
              <tr>
                <th scope="col" class="px-3 py-2">编队 ID</th>
                <th scope="col" class="px-3 py-2">名称</th>
                <th scope="col" class="px-3 py-2">车辆</th>
                <th scope="col" class="px-3 py-2">场景</th>
                <th scope="col" class="px-3 py-2 text-right">操作</th>
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
                <th scope="row" class="px-3 py-2 font-mono text-2xs text-ink">
                  {{ formation.formationId }}
                </th>
                <td class="px-3 py-2 text-ink-muted">
                  {{ formation.formationName }}
                </td>
                <td class="px-3 py-2 text-ink-muted">
                  {{ formation.deviceIds.length }} 台
                </td>
                <td class="px-3 py-2 text-ink-muted">
                  {{ formation.sceneId || "—" }}
                </td>
                <td class="px-3 py-2">
                  <div class="flex justify-end gap-1">
                    <UiButton
                      variant="ghost"
                      size="sm"
                      @click="openFormationEdit(formation)"
                      >编辑</UiButton
                    >
                    <UiButton
                      variant="ghost"
                      size="sm"
                      @click="
                        confirm = {
                          kind: 'formation',
                          id: formation.formationId,
                          label:
                            formation.formationName || formation.formationId,
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
      </section>
    </template>
  </PageHeader>

  <!-- Vehicle create/edit -->
  <DialogRoot
    :open="vMode !== null"
    @update:open="
      (o) => {
        if (!o) closeVehicle();
      }
    "
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-scrim/55" />
      <DialogContent
        class="fixed top-1/2 left-1/2 z-50 flex w-full max-w-100 -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-md border border-border bg-surface-raised p-5 shadow-overlay"
      >
        <DialogTitle class="text-md font-semibold text-ink">{{
          vTitle
        }}</DialogTitle>
        <DialogDescription class="sr-only"
          >填写车辆配置后提交</DialogDescription
        >
        <form
          class="flex flex-col gap-3"
          :aria-busy="vSaving"
          @submit.prevent="submitVehicle"
        >
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">设备 ID</span>
            <input
              v-model="fDeviceId"
              type="text"
              :disabled="vMode === 'edit' || vSaving"
              :class="INPUT_CLASS"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">名称</span>
            <input
              v-model="fDeviceName"
              type="text"
              :disabled="vSaving"
              :class="INPUT_CLASS"
            />
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
            <span class="text-sm font-medium text-ink">标签（逗号分隔）</span>
            <input
              v-model="fTags"
              type="text"
              :disabled="vSaving"
              :class="INPUT_CLASS"
            />
          </label>
          <label class="flex items-center gap-2">
            <input v-model="fGps" type="checkbox" :disabled="vSaving" />
            <span class="text-sm text-ink">在 GPS 地图中显示</span>
          </label>
          <label class="flex items-center gap-2">
            <input v-model="fRosMap" type="checkbox" :disabled="vSaving" />
            <span class="text-sm text-ink">在场景地图中显示</span>
          </label>
          <p v-if="vError" class="text-sm text-critical-ink" role="alert">
            {{ vError }}
          </p>
          <div class="mt-1 flex justify-end gap-2">
            <UiButton
              variant="secondary"
              size="sm"
              :disabled="vSaving"
              @click="closeVehicle"
              >取消</UiButton
            >
            <UiButton type="submit" size="sm" :disabled="vSaving">
              {{ vSaving ? "提交中…" : "保存" }}
            </UiButton>
          </div>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
  <!-- Formation create/edit -->
  <DialogRoot
    :open="gMode !== null"
    @update:open="
      (o) => {
        if (!o) closeFormation();
      }
    "
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-50 bg-scrim/55" />
      <DialogContent
        class="fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-full max-w-100 -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-auto rounded-md border border-border bg-surface-raised p-5 shadow-overlay"
      >
        <DialogTitle class="text-md font-semibold text-ink">{{
          gTitle
        }}</DialogTitle>
        <DialogDescription class="sr-only"
          >填写编队配置后提交</DialogDescription
        >
        <form
          class="flex flex-col gap-3"
          :aria-busy="gSaving"
          @submit.prevent="submitFormation"
        >
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">编队 ID</span>
            <input
              v-model="gFormationId"
              type="text"
              :disabled="gMode === 'edit' || gSaving"
              :class="INPUT_CLASS"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">名称</span>
            <input
              v-model="gFormationName"
              type="text"
              :disabled="gSaving"
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
                  :checked="gDeviceIds.includes(option.value)"
                  :disabled="gSaving"
                  @change="toggleFormationDevice(option.value)"
                />
                <span class="text-sm text-ink">{{ option.label }}</span>
              </label>
            </div>
          </fieldset>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">默认场景</span>
            <UiSelect
              v-model="gSceneId"
              :options="sceneOptions"
              aria-label="编队默认场景"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">描述</span>
            <input
              v-model="gDescription"
              type="text"
              :disabled="gSaving"
              :class="INPUT_CLASS"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink"
              >颜色（可选，如 #46d7c3）</span
            >
            <input
              v-model="gColor"
              type="text"
              :disabled="gSaving"
              :class="INPUT_CLASS"
            />
          </label>
          <p v-if="gError" class="text-sm text-critical-ink" role="alert">
            {{ gError }}
          </p>
          <div class="mt-1 flex justify-end gap-2">
            <UiButton
              variant="secondary"
              size="sm"
              :disabled="gSaving"
              @click="closeFormation"
              >取消</UiButton
            >
            <UiButton type="submit" size="sm" :disabled="gSaving">
              {{ gSaving ? "提交中…" : "保存" }}
            </UiButton>
          </div>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>

  <UiConfirmDialog
    :open="confirm !== null"
    :title="confirmCopy.title"
    :description="confirmCopy.description"
    :confirm-label="confirmCopy.label"
    :pending="deleting"
    @update:open="
      (o) => {
        if (!o) confirm = null;
      }
    "
    @confirm="runDelete"
  />
</template>
