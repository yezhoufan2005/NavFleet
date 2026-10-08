<script setup lang="ts">
/**
 * 部署 / 场景 — what the deployment has configured, whether it is actually there, and (Phase 18)
 * editing it: create / edit / delete scene entries and upload their backdrop files.
 *
 * This was read-only on the stated ground that "editing a scene means editing the map a vehicle
 * localises against". Phase 18 reverses that for the same reason the device-onboarding wizard
 * did: the console renders these backdrops, it does not push maps to vehicles, so writing scene
 * config is operator/deployment domain and the read-only red line (no command dispatch) holds.
 * The backend re-validates every write and confines uploads to the scene-maps root.
 *
 * ## Why it checks the resources rather than just listing them
 *
 * The single most confusing failure this console can show is a scene that renders as
 * 暂无可用地图 or with a blank backdrop, because every plausible cause looks identical
 * from the map: the scene has no `imageUrl`, or it has one and the file 404s, or the
 * point cloud is there and the metadata beside it is not. Phase 1 shipped with
 * `scenes.json` naming three SVGs that did not exist, and defect 9.4 is the raster
 * backdrop failing *silently*. So each configured URL is fetched and reported as
 * present or missing.
 *
 * The check is a `GET` with `Range: bytes=0-0`, not a `HEAD`: nginx serves static
 * files under `/scene-maps/` and a HEAD there is fine, but a point cloud can be tens
 * of megabytes and some setups answer HEAD from a different code path than GET. Asking
 * for one byte tests the path the map itself will use, without paying for the file.
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
import PageHeader from "@/components/PageHeader.vue";
import AppSectionTabs from "@/components/shell/AppSectionTabs.vue";
import UiButton from "@/components/ui/UiButton.vue";
import UiInput from "@/components/ui/UiInput.vue";
import UiSelect from "@/components/ui/UiSelect.vue";
import UiConfirmDialog from "@/components/ui/UiConfirmDialog.vue";
import { makeMessageFor } from "@/lib/errorMessages";
import { notify } from "@/composables/useNotifications";
import { useAutoRefresh } from "@/composables/useAutoRefresh";
import { useFleetStore } from "@/stores/fleet";
import { fleetApi, formatNumber } from "@navfleet/fleet-core";
import type { SceneAssetKind, SceneDefinition } from "@navfleet/fleet-core";
import type { SceneMapDefinition } from "@navfleet/shared";

const fleet = useFleetStore();

const status = ref<"loading" | "ready" | "error">("loading");
const errorMessage = ref("");
const scenes = ref<SceneDefinition[]>([]);

/** `url → present`. Absent from the map means "not checked yet". */
const resourceState = ref<Record<string, boolean | "checking">>({});

type ResourceKind = {
  field: string;
  label: string;
  /** What the map loses when this one is missing. */
  consequence: string;
};

/**
 * The resource fields a scene can carry, in the order the map consumes them. Written
 * out rather than derived, because each needs its own sentence about what breaks —
 * "this URL 404s" is only useful next to what the operator will therefore not see.
 */
const RESOURCE_KINDS: readonly ResourceKind[] = [
  {
    field: "imageUrl",
    label: "栅格底图",
    consequence: "地图没有底图，只剩边框与车辆标记",
  },
  {
    field: "metadataUrl",
    label: "底图元数据",
    consequence: "缺它时用场景自身的 origin / resolution，通常仍可显示",
  },
  {
    field: "pointCloudUrl",
    label: "点云",
    consequence: "点云背景不出现，地图会退回栅格底图或空白",
  },
  {
    field: "pointCloudMetaUrl",
    label: "点云元数据",
    consequence: "点云无法定位到世界坐标，背景会被跳过",
  },
  {
    field: "overlayUrl",
    label: "路网叠加（Lanelet2）",
    consequence: "地图上没有车道线，只有底图与车辆",
  },
  {
    field: "osmUrl",
    label: "OSM 源文件",
    consequence: "后端据它生成路网叠加；缺它时叠加也不会有",
  },
];

/**
 * One byte, through the same path the map uses. A rejected fetch and a non-2xx are
 * both "missing" as far as an operator is concerned — the distinction between a 404
 * and a broken proxy is in the browser's network panel, not on this page.
 */
const checkResource = async (url: string): Promise<void> => {
  resourceState.value[url] = "checking";
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { Range: "bytes=0-0" },
    });
    resourceState.value[url] = response.ok || response.status === 206;
  } catch {
    resourceState.value[url] = false;
  }
};

const urlsOf = (scene: SceneDefinition): string[] =>
  RESOURCE_KINDS.map((kind) => scene[kind.field] as string | undefined).filter(
    (url): url is string => typeof url === "string" && url.length > 0,
  );

const load = async (): Promise<void> => {
  status.value = "loading";
  errorMessage.value = "";
  try {
    const payload = await fleetApi.getScenes();
    scenes.value = [...(payload.items ?? [])].sort((left, right) =>
      String(left.sceneId).localeCompare(String(right.sceneId)),
    );
    status.value = "ready";
    // Checks run after the list renders, so the page is readable while they land.
    await Promise.all(
      scenes.value.flatMap((scene) => urlsOf(scene).map(checkResource)),
    );
  } catch (error) {
    status.value = "error";
    errorMessage.value =
      error instanceof Error ? error.message : "场景列表加载失败";
  }
};

onMounted(() => void load());

/** Vehicles configured onto each scene — the reason a broken map matters. */
const devicesByScene = computed<Record<string, string[]>>(() => {
  const map: Record<string, string[]> = {};
  for (const device of fleet.devices) {
    const sceneId = device.sceneId;
    if (!sceneId) continue;
    (map[sceneId] ??= []).push(device.deviceName || device.deviceId);
  }
  return map;
});

interface ResourceRow {
  label: string;
  url: string;
  consequence: string;
  state: boolean | "checking";
}

const rowsOf = (scene: SceneDefinition): ResourceRow[] =>
  RESOURCE_KINDS.flatMap((kind) => {
    const url = scene[kind.field] as string | undefined;
    if (!url) return [];
    return [
      {
        label: kind.label,
        url,
        consequence: kind.consequence,
        state: resourceState.value[url] ?? "checking",
      },
    ];
  });

/** The world extent, stated the way the map derives it. */
const extentOf = (scene: SceneDefinition): string => {
  const bounds = scene.bounds as
    { minX: number; maxX: number; minY: number; maxY: number } | undefined;
  if (bounds) {
    return `x ${formatNumber(bounds.minX, 1)} – ${formatNumber(bounds.maxX, 1)} · y ${formatNumber(bounds.minY, 1)} – ${formatNumber(bounds.maxY, 1)}`;
  }
  const width = Number(scene.width);
  const height = Number(scene.height);
  const resolution = Number(scene.resolution);
  if (![width, height, resolution].every(Number.isFinite)) return "--";
  // Same derivation SceneMap does when a scene states no bounds.
  return `${formatNumber(width * resolution, 1)} × ${formatNumber(height * resolution, 1)} m（由宽高与分辨率推出）`;
};

const missingCount = computed(
  () =>
    scenes.value.filter((scene) =>
      rowsOf(scene).some((row) => row.state === false),
    ).length,
);

// ── Create / edit / delete (admin) ──────────────────────────────────────────
/** Upload kinds offered in the form, with the scene URL field each fills. */
const ASSET_KINDS: { value: SceneAssetKind; label: string; field: string }[] = [
  { value: "image", label: "栅格底图（SVG/PNG/JPG）", field: "imageUrl" },
  { value: "pointcloud", label: "点云（PCD）", field: "pointCloudUrl" },
  { value: "osm", label: "路网源文件（OSM）", field: "osmUrl" },
  {
    value: "pointcloudmeta",
    label: "点云元数据（JSON）",
    field: "pointCloudMetaUrl",
  },
];
const ASSET_KIND_OPTIONS = ASSET_KINDS.map(({ value, label }) => ({
  value,
  label,
}));

const ERROR_MESSAGES: Record<string, string> = {
  invalid_scenes: "场景配置不合法，请检查各字段",
  invalid_asset: "上传的文件内容不合法",
  invalid_asset_kind: "不支持的底图类型",
  asset_too_large: "文件超过大小上限",
  empty_upload: "文件为空",
  forbidden: "需要管理员权限",
};
const messageFor = makeMessageFor(ERROR_MESSAGES);

type Mode = "create" | "edit" | null;
const mode = ref<Mode>(null);
const saving = ref(false);
const formError = ref("");
const editingId = ref("");
const fSceneId = ref("");
const fSceneName = ref("");
const fMapFrame = ref("map");
const fResolution = ref("0.05");
const fWidth = ref("");
const fHeight = ref("");
const fOriginX = ref("0");
const fOriginY = ref("0");
const fOriginYaw = ref("0");
const fAssetKind = ref<SceneAssetKind>("image");
const fAssetFile = ref<File | null>(null);

const dialogTitle = computed(() =>
  mode.value === "create" ? "新增场景" : "编辑场景",
);

const openCreate = (): void => {
  mode.value = "create";
  formError.value = "";
  editingId.value = "";
  fSceneId.value = "";
  fSceneName.value = "";
  fMapFrame.value = "map";
  fResolution.value = "0.05";
  fWidth.value = "";
  fHeight.value = "";
  fOriginX.value = "0";
  fOriginY.value = "0";
  fOriginYaw.value = "0";
  fAssetKind.value = "image";
  fAssetFile.value = null;
};

const openEdit = (scene: SceneDefinition): void => {
  mode.value = "edit";
  formError.value = "";
  editingId.value = String(scene.sceneId);
  fSceneId.value = String(scene.sceneId);
  fSceneName.value = String(scene.sceneName ?? "");
  fMapFrame.value = String(scene.mapFrame ?? "map");
  fResolution.value = String(scene.resolution ?? "");
  fWidth.value = String(scene.width ?? "");
  fHeight.value = String(scene.height ?? "");
  const origin = scene.origin as
    { x?: number; y?: number; yaw?: number } | undefined;
  fOriginX.value = String(origin?.x ?? 0);
  fOriginY.value = String(origin?.y ?? 0);
  fOriginYaw.value = String(origin?.yaw ?? 0);
  fAssetKind.value = "image";
  fAssetFile.value = null;
};

const close = (): void => {
  mode.value = null;
};

const onFileChosen = (event: Event): void => {
  const input = event.target as HTMLInputElement;
  fAssetFile.value = input.files?.[0] ?? null;
};

const positive = (value: string): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const submit = async (): Promise<void> => {
  formError.value = "";
  const id = fSceneId.value.trim();
  if (!id) {
    formError.value = "请输入场景 ID";
    return;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id) || /^\.+$/.test(id)) {
    formError.value = "场景 ID 只能是字母、数字、点、下划线、连字符";
    return;
  }
  if (mode.value === "create" && scenes.value.some((s) => s.sceneId === id)) {
    formError.value = "场景 ID 已存在";
    return;
  }
  const resolution = positive(fResolution.value);
  const width = positive(fWidth.value);
  const height = positive(fHeight.value);
  if (resolution === null || width === null || height === null) {
    formError.value = "分辨率、宽、高都必须是大于 0 的数";
    return;
  }
  const originX = Number(fOriginX.value);
  const originY = Number(fOriginY.value);
  const originYaw = Number(fOriginYaw.value);
  if (![originX, originY, originYaw].every(Number.isFinite)) {
    formError.value = "原点坐标必须是数字";
    return;
  }

  saving.value = true;
  try {
    const existing =
      mode.value === "edit"
        ? scenes.value.find((s) => s.sceneId === editingId.value)
        : undefined;
    const entry: Record<string, unknown> = {
      ...(existing ?? {}),
      sceneId: id,
      sceneName: fSceneName.value.trim() || id,
      mapFrame: fMapFrame.value.trim() || "map",
      resolution,
      width,
      height,
      origin: { x: originX, y: originY, yaw: originYaw },
    };
    // A chosen file uploads first; the returned /scene-maps/ URL goes onto the entry so the
    // written scenes.json points at it (a new file) — an in-place replace returns the same URL.
    if (fAssetFile.value) {
      const field = ASSET_KINDS.find(
        (k) => k.value === fAssetKind.value,
      )!.field;
      const { url } = await fleetApi.uploadSceneAsset(
        id,
        fAssetKind.value,
        fAssetFile.value,
      );
      entry[field] = url;
    }
    const next = [
      ...scenes.value.filter((s) => s.sceneId !== id),
      entry,
    ] as unknown as SceneMapDefinition[];
    await fleetApi.putScenes(next);
    notify(mode.value === "create" ? "已新增场景" : "已更新场景", {
      type: "success",
    });
    close();
    await load();
  } catch (error) {
    formError.value = messageFor(error);
    notify(messageFor(error), {
      type: "error",
      dedupeKey: "scene-write-failed",
    });
  } finally {
    saving.value = false;
  }
};

const confirmDelete = ref<{ id: string; label: string } | null>(null);
const deleting = ref(false);

// Re-read the scene list (and re-probe its resources) when the operator returns to the tab,
// instead of a manual 重新检查 button — but never while a create/edit dialog or the delete
// confirm is open, so a refresh cannot pull the form out from under an in-progress edit.
useAutoRefresh(() => void load(), {
  enabled: () => mode.value === null && confirmDelete.value === null,
});

const runDelete = async (): Promise<void> => {
  const target = confirmDelete.value;
  if (!target) return;
  deleting.value = true;
  try {
    const next = scenes.value.filter(
      (s) => s.sceneId !== target.id,
    ) as unknown as SceneMapDefinition[];
    await fleetApi.putScenes(next);
    notify("已删除场景", { type: "success" });
    confirmDelete.value = null;
    await load();
  } catch (error) {
    notify(messageFor(error), {
      type: "error",
      dedupeKey: "scene-delete-failed",
    });
  } finally {
    deleting.value = false;
  }
};
</script>

<template>
  <PageHeader title="部署">
    <template #actions>
      <UiButton size="sm" :disabled="status !== 'ready'" @click="openCreate">
        新增场景
      </UiButton>
    </template>

    <AppSectionTabs />

    <p v-if="status === 'loading'" class="text-sm text-ink-muted" role="status">
      正在读取场景配置…
    </p>

    <p
      v-else-if="status === 'error'"
      class="text-sm text-critical-ink"
      role="status"
    >
      {{ errorMessage }}
    </p>

    <p v-else-if="!scenes.length" class="text-sm text-ink-muted">
      车队没有配置任何场景；设备仍会以 GPS 显示，但场景地图不可用
    </p>

    <template v-else>
      <!-- Stated up front because it is the answer someone came here for. -->
      <p
        v-if="missingCount"
        class="m-0 rounded-sm border border-warning bg-warning-wash px-3 py-2 text-sm text-warning-ink"
        role="status"
      >
        {{ missingCount }}
        个场景有取不到的资源，下面逐条标出；这类缺失在地图上看起来只是"没有底图"
      </p>

      <section
        v-for="scene in scenes"
        :key="scene.sceneId"
        class="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
      >
        <header class="flex flex-wrap items-baseline gap-2">
          <h3 class="text-md font-semibold text-ink">
            {{ scene.sceneName || scene.sceneId }}
          </h3>
          <span class="font-mono text-2xs text-ink-subtle">{{
            scene.sceneId
          }}</span>
          <div class="ml-auto flex gap-1">
            <UiButton variant="ghost" size="sm" @click="openEdit(scene)"
              >编辑</UiButton
            >
            <UiButton
              variant="ghost"
              size="sm"
              @click="
                confirmDelete = {
                  id: String(scene.sceneId),
                  label: String(scene.sceneName || scene.sceneId),
                }
              "
              >删除</UiButton
            >
          </div>
        </header>

        <dl class="m-0 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <div class="flex flex-col gap-0.5">
            <dt class="text-xs text-ink-muted">世界范围</dt>
            <dd class="m-0 font-mono text-sm text-ink">
              {{ extentOf(scene) }}
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-xs text-ink-muted">分辨率</dt>
            <dd class="m-0 font-mono text-sm text-ink">
              {{ formatNumber(scene.resolution, 3, " m/px") }}
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-xs text-ink-muted">地图坐标系</dt>
            <dd class="m-0 font-mono text-sm text-ink">
              {{ scene.mapFrame || "--" }}
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-xs text-ink-muted">在此场景的车辆</dt>
            <dd class="m-0 truncate text-sm text-ink">
              {{ (devicesByScene[scene.sceneId] ?? []).join("、") || "无" }}
            </dd>
          </div>
        </dl>

        <div v-if="rowsOf(scene).length" class="flex flex-col gap-2">
          <h4
            class="font-mono text-2xs tracking-wider text-ink-subtle uppercase"
          >
            地图资源
          </h4>
          <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
            <li
              v-for="row in rowsOf(scene)"
              :key="row.url"
              class="flex flex-col gap-0.5 rounded-sm border border-border bg-surface p-2.5"
            >
              <div class="flex flex-wrap items-baseline gap-2">
                <span class="text-sm text-ink">{{ row.label }}</span>
                <!-- In words, not only a colour: this is the state the page exists
                     to report. -->
                <span
                  class="rounded-xs px-1.5 py-0.5 font-mono text-2xs"
                  :class="
                    row.state === 'checking'
                      ? 'bg-surface-sunken text-ink-muted'
                      : row.state
                        ? 'bg-brand-wash text-brand-ink'
                        : 'bg-critical-wash text-critical-ink'
                  "
                >
                  {{
                    row.state === "checking"
                      ? "检查中"
                      : row.state
                        ? "可取得"
                        : "取不到"
                  }}
                </span>
                <code
                  class="ml-auto font-mono text-2xs break-all text-ink-subtle"
                  >{{ row.url }}</code
                >
              </div>
              <p
                v-if="row.state === false"
                class="m-0 text-xs text-critical-ink"
              >
                {{ row.consequence }}
              </p>
            </li>
          </ul>
        </div>

        <p v-else class="m-0 text-sm text-ink-muted">
          这个场景没有配置任何地图资源，所以它只提供坐标范围，地图区会显示"暂无可用地图"
        </p>
      </section>
    </template>
  </PageHeader>

  <!-- Create / edit scene -->
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
          >填写场景几何参数并可上传底图后提交</DialogDescription
        >
        <form
          class="flex flex-col gap-3"
          :aria-busy="saving"
          @submit.prevent="submit"
        >
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">场景 ID</span>
            <UiInput
              v-model="fSceneId"
              type="text"
              :disabled="mode === 'edit' || saving"
              size="md"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">名称</span>
            <UiInput
              v-model="fSceneName"
              type="text"
              :disabled="saving"
              size="md"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-ink">地图坐标系</span>
            <UiInput
              v-model="fMapFrame"
              type="text"
              :disabled="saving"
              size="md"
            />
          </label>
          <div class="grid grid-cols-3 gap-2">
            <label class="flex flex-col gap-1">
              <span class="text-sm font-medium text-ink">分辨率 m/px</span>
              <UiInput
                v-model="fResolution"
                type="text"
                :disabled="saving"
                size="md"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm font-medium text-ink">宽 px</span>
              <UiInput
                v-model="fWidth"
                type="text"
                :disabled="saving"
                size="md"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm font-medium text-ink">高 px</span>
              <UiInput
                v-model="fHeight"
                type="text"
                :disabled="saving"
                size="md"
              />
            </label>
          </div>
          <div class="grid grid-cols-3 gap-2">
            <label class="flex flex-col gap-1">
              <span class="text-sm font-medium text-ink">原点 x</span>
              <UiInput
                v-model="fOriginX"
                type="text"
                :disabled="saving"
                size="md"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm font-medium text-ink">原点 y</span>
              <UiInput
                v-model="fOriginY"
                type="text"
                :disabled="saving"
                size="md"
              />
            </label>
            <label class="flex flex-col gap-1">
              <span class="text-sm font-medium text-ink">原点 yaw</span>
              <UiInput
                v-model="fOriginYaw"
                type="text"
                :disabled="saving"
                size="md"
              />
            </label>
          </div>
          <fieldset
            class="flex flex-col gap-2 rounded-sm border border-border p-2"
          >
            <legend class="px-1 text-sm font-medium text-ink">
              底图（可选）
            </legend>
            <p class="m-0 text-xs text-ink-muted">
              选类型并上传文件；已引用同类底图时就地替换，否则落到 scene-maps 下
            </p>
            <UiSelect
              v-model="fAssetKind"
              :options="ASSET_KIND_OPTIONS"
              aria-label="底图类型"
            />
            <input
              type="file"
              :disabled="saving"
              class="text-sm text-ink"
              @change="onFileChosen"
            />
          </fieldset>
          <p
            v-if="formError"
            class="m-0 text-sm text-critical-ink"
            role="alert"
          >
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
    :title="`删除场景 ${confirmDelete?.label ?? ''}？`"
    description="仅从 scenes.json 移除该场景条目；已上传的底图文件不受影响；该场景上的车辆会退回 GPS 或空白地图"
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
