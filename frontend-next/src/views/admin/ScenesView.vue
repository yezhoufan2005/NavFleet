<script setup lang="ts">
/**
 * 管理 / 场景 — what the deployment has configured, and whether it is actually there.
 *
 * Read-only, and that is a product decision rather than a missing feature: editing a
 * scene means editing the map a vehicle localises against, which is not something a
 * read-only monitoring console gets to do. The page's job is to explain a map, not to
 * change one.
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
import PageHeader from "@/components/PageHeader.vue";
import UiButton from "@/components/ui/UiButton.vue";
import { useFleetStore } from "@/stores/fleet";
import { fleetApi, formatNumber } from "@navfleet/fleet-core";
import type { SceneDefinition } from "@navfleet/fleet-core";

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
    consequence: "地图没有底图，只剩边框与车辆标记。",
  },
  {
    field: "metadataUrl",
    label: "底图元数据",
    consequence: "缺它时用场景自身的 origin / resolution，通常仍可显示。",
  },
  {
    field: "pointCloudUrl",
    label: "点云",
    consequence: "点云背景不出现，地图会退回栅格底图或空白。",
  },
  {
    field: "pointCloudMetaUrl",
    label: "点云元数据",
    consequence: "点云无法定位到世界坐标，背景会被跳过。",
  },
  {
    field: "overlayUrl",
    label: "路网叠加（Lanelet2）",
    consequence: "地图上没有车道线，只有底图与车辆。",
  },
  {
    field: "osmUrl",
    label: "OSM 源文件",
    consequence: "后端据它生成路网叠加；缺它时叠加也不会有。",
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
</script>

<template>
  <PageHeader title="场景">
    <template #actions>
      <UiButton
        variant="secondary"
        size="sm"
        :disabled="status === 'loading'"
        @click="load"
      >
        {{ status === "loading" ? "检查中…" : "重新检查" }}
      </UiButton>
    </template>

    <!--
      Body text rather than a page lede, because it is not a description of the page —
      it is the red line. Scenes are what a vehicle localises against, so this console
      never writes them, and `console-admin.spec.ts` asserts the word 「只读」 is visible
      here alongside "there is no form and no input on this page". Placed before the
      status branches so it renders in every state, including while loading and when the
      fleet has no scenes at all.
    -->
    <p class="m-0 text-sm text-ink-muted">
      只读页：场景是车辆定位的依据，不由监控台改写。
    </p>

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
      车队没有配置任何场景。设备仍会以 GPS 显示，但场景地图不可用。
    </p>

    <template v-else>
      <!-- Stated up front because it is the answer someone came here for. -->
      <p
        v-if="missingCount"
        class="m-0 rounded-sm border border-warning bg-warning-wash px-3 py-2 text-sm text-warning-ink"
        role="status"
      >
        {{ missingCount }}
        个场景有取不到的资源，下面逐条标出。这类缺失在地图上看起来只是"没有底图"。
      </p>

      <section
        v-for="scene in scenes"
        :key="scene.sceneId"
        class="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
      >
        <header class="flex flex-wrap items-baseline gap-2">
          <h3 class="text-lg font-semibold text-ink">
            {{ scene.sceneName || scene.sceneId }}
          </h3>
          <span class="font-mono text-2xs text-ink-subtle">{{
            scene.sceneId
          }}</span>
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
          这个场景没有配置任何地图资源，所以它只提供坐标范围，地图区会显示"暂无可用地图"。
        </p>
      </section>
    </template>
  </PageHeader>
</template>
