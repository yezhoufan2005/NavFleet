<script setup lang="ts">
/**
 * 管理 / 系统状态 — the page that answers "whose fault is it".
 *
 * `docs/frontend-ia.md` sends the old settings page's connection diagnostics here
 * (personal preferences went to the user menu instead). The reason this is worth a
 * page rather than a tooltip on the top bar's status dot: that dot reports **one**
 * link, and an operator seeing 重连中 cannot tell which of three things broke.
 *
 * ```
 * 浏览器 ──HTTP/WS──▶ 后端 ──MQTT──▶ broker
 *                      └──▶ MongoDB
 * ```
 *
 * So the page reads both ends. `/health/ready` is public and unproxied by nothing —
 * it is served through nginx in the image and through Vite's proxy in dev — and it
 * reports the backend's own view of Mongo and the broker. Put beside the console's
 * view of its own socket, the pair separates "I cannot reach the backend" from "the
 * backend cannot reach the broker", which are different phone calls.
 *
 * A 503 from readiness is **an answer, not an error**: the endpoint returns it while
 * the store is still initialising. Only a fetch that throws means the backend is
 * unreachable — and then the failure to reach it *is* the diagnosis, which is why it
 * renders as one rather than as "加载失败".
 *
 * The local-state section exists because half of the puzzling states in this console
 * come from a preference someone set months ago in a browser they have since
 * forgotten about. It is discovered by prefix scan, never from a list — see
 * `lib/localState.ts`.
 */
import { computed, onMounted, ref } from "vue";
import PageHeader from "@/components/PageHeader.vue";
import UiButton from "@/components/ui/UiButton.vue";
import { useFleetStore } from "@/stores/fleet";
import { formatDateTime } from "@navfleet/fleet-core";
import {
  clearStoredState,
  readStoredState,
  type StoredEntry,
} from "@/lib/localState";

interface ReadyPayload {
  ready?: boolean;
  degraded?: boolean;
  checks?: { store?: boolean; mongo?: boolean; mqtt?: boolean };
  now?: string;
}

const fleet = useFleetStore();

const probeState = ref<"loading" | "answered" | "unreachable">("loading");
const probeError = ref("");
const ready = ref<ReadyPayload | null>(null);
const probedAt = ref<number | null>(null);

/**
 * Read `/health/ready` directly rather than through `fleetApi`.
 *
 * Two reasons: it is not under `/api/v1`, and it answers 503 on purpose — a helper
 * that throws on any non-2xx would turn the most interesting answer into an
 * exception.
 */
const probe = async (): Promise<void> => {
  probeState.value = "loading";
  probeError.value = "";
  try {
    const response = await fetch("/health/ready", { cache: "no-store" });
    ready.value = (await response.json()) as ReadyPayload;
    probeState.value = "answered";
  } catch (error) {
    ready.value = null;
    probeState.value = "unreachable";
    probeError.value = error instanceof Error ? error.message : String(error);
  } finally {
    probedAt.value = Date.now();
  }
};

onMounted(() => void probe());

type Tone = "ok" | "warning" | "critical" | "offline";

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-brand",
  warning: "bg-warning",
  critical: "bg-critical",
  offline: "bg-offline",
};

interface Check {
  label: string;
  /** The state in words. Colour never carries this alone. */
  value: string;
  tone: Tone;
  detail: string;
}

/**
 * The backend's own dependencies. Mongo and the broker are reported as **degraded**
 * rather than broken, because the store is designed to keep serving without either —
 * calling a running-but-degraded deployment "critical" would cry wolf.
 */
const backendChecks = computed<Check[]>(() => {
  if (probeState.value === "unreachable") {
    return [
      {
        label: "后端可达性",
        value: "无法访问",
        tone: "critical",
        detail: `浏览器连不上 /health/ready（${probeError.value}）。这一条不通时，下面三项无从判断 —— 它们是后端对自己的报告。`,
      },
    ];
  }
  const checks = ready.value?.checks ?? {};
  return [
    {
      label: "后端可达性",
      value: "可访问",
      tone: "ok",
      detail: "浏览器能取到 /health/ready，所以下面三项是后端此刻的自述。",
    },
    {
      label: "快照就绪",
      value: checks.store ? "就绪" : "初始化中",
      tone: checks.store ? "ok" : "warning",
      detail: checks.store
        ? "内存快照已建立，REST 与 WebSocket 都能给出完整车队。"
        : "后端仍在初始化快照，此时 /health/ready 返回 503 —— 这是答案而不是错误。",
    },
    {
      label: "MongoDB",
      value: checks.mongo ? "已连接" : "未连接",
      tone: checks.mongo ? "ok" : "warning",
      detail: checks.mongo
        ? "遥测与告警在落库，历史回放有数据可读。"
        : "实时监控不受影响，但历史回放与曲线会是空的 —— 那两处的空态说的就是这件事。",
    },
    {
      label: "MQTT broker",
      value: checks.mqtt ? "已连接" : "未连接",
      tone: checks.mqtt ? "ok" : "critical",
      detail: checks.mqtt
        ? "车辆上报的链路是通的。"
        : "后端收不到车辆上报，所以画面会随离线阈值逐台变灰。这一条不通时，界面看起来像「车都停了」。",
    },
  ];
});

/** The console's own half: the socket this tab holds. */
const linkChecks = computed<Check[]>(() => {
  const realtime = fleet.state.realtime;
  return [
    {
      label: "WebSocket",
      value: fleet.connection.label,
      tone:
        fleet.connection.tone === "pending" ? "offline" : fleet.connection.tone,
      detail: fleet.connection.detail,
    },
    {
      label: "重连次数",
      value: String(realtime.reconnectAttempts),
      tone: realtime.reconnectAttempts > 0 ? "warning" : "ok",
      detail:
        realtime.reconnectAttempts > 0
          ? "这一栏不为零说明链路曾经断过，即使现在显示实时。"
          : "本次会话未发生重连。",
    },
    {
      label: "首次快照",
      value: realtime.apiReady ? "已取得" : "未取得",
      tone: realtime.apiReady ? "ok" : "critical",
      detail: realtime.apiReady
        ? "REST 引导成功，界面上的车队来自后端而不是本地兜底。"
        : "REST 引导没成功，界面显示的是本地兜底内容。",
    },
  ];
});

/**
 * Two clocks, side by side, because that is the only way clock skew is visible.
 * `serverUpdatedAt` is what the backend stamped; `lastUpdateAt` is when this tab
 * received it. A gap that grows is a skewed browser, not a stale fleet.
 */
const clockRows = computed(() => [
  {
    label: "后端标记的更新时间",
    value: fleet.state.serverUpdatedAt
      ? formatDateTime(fleet.state.serverUpdatedAt)
      : "--",
  },
  {
    label: "本浏览器收到的时间",
    value: fleet.state.lastUpdateAt
      ? formatDateTime(fleet.state.lastUpdateAt)
      : "--",
  },
  {
    label: "本页探测时间",
    value: probedAt.value === null ? "--" : formatDateTime(probedAt.value),
  },
]);

const fleetRows = computed(() => [
  { label: "车队名称", value: fleet.state.fleetName || "--" },
  { label: "订阅主题", value: fleet.state.topicPattern || "--" },
  { label: "设备数", value: String(fleet.devices.length) },
]);

// ── local state ────────────────────────────────────────────────────────────────
const stored = ref<StoredEntry[]>([]);
const clearing = ref(false);

const refreshStored = (): void => {
  stored.value = readStoredState();
};

onMounted(refreshStored);

/**
 * Clear, then reload. The composables that wrote these keys are module singletons
 * that read storage once at import, so deleting the key does not undo the preference
 * already in memory — a reload is what makes the page's claim true.
 */
const clearLocal = (): void => {
  clearing.value = true;
  clearStoredState();
  window.location.reload();
};

const AREA_LABELS: Record<StoredEntry["area"], string> = {
  local: "长期",
  session: "本标签页",
};
</script>

<template>
  <PageHeader
    title="系统状态"
    lede="链路诊断与本浏览器留存的数据。顶栏的状态点只报一条链路；这一页把两端都读出来。"
  >
    <template #actions>
      <UiButton
        variant="secondary"
        size="sm"
        :disabled="probeState === 'loading'"
        @click="probe"
      >
        {{ probeState === "loading" ? "检查中…" : "再次检查" }}
      </UiButton>
    </template>

    <section
      class="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
      aria-labelledby="backend-heading"
    >
      <div class="flex flex-col gap-1">
        <h3 id="backend-heading" class="text-lg font-semibold text-ink">
          后端与它的依赖
        </h3>
        <p class="m-0 max-w-prose text-sm text-ink-muted">
          来自
          <code class="font-mono text-xs">/health/ready</code
          >，也就是后端对自己的报告。它与下一节合起来才能分清"我连不上后端"和"后端连不上
          broker"。
        </p>
      </div>

      <!--
        A list rather than a `<dl>`. Each row carries three things — a label, a state,
        and a sentence about what that state costs — so it is not a term/definition
        pair, and axe is right to reject `dl > div > div > dt`: the allowed shape is
        `dl > div > (dt, dd)` and nothing deeper. The two small panels below *are*
        label→value, and stay definition lists.
      -->
      <ul class="m-0 flex list-none flex-col gap-2 p-0">
        <li
          v-for="check in backendChecks"
          :key="check.label"
          class="flex flex-col gap-1 rounded-sm border border-border bg-surface p-3"
        >
          <div class="flex items-baseline gap-2">
            <span class="text-sm text-ink-muted">{{ check.label }}</span>
            <!-- The word carries the state; the dot only repeats it. -->
            <span class="ml-auto flex items-center gap-1.5">
              <span
                class="size-2 shrink-0 rounded-full"
                :class="TONE_DOT[check.tone]"
                aria-hidden="true"
              />
              <strong class="text-sm text-ink">{{ check.value }}</strong>
            </span>
          </div>
          <p class="m-0 text-xs text-ink-muted">{{ check.detail }}</p>
        </li>
      </ul>
    </section>

    <section
      class="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
      aria-labelledby="link-heading"
    >
      <div class="flex flex-col gap-1">
        <h3 id="link-heading" class="text-lg font-semibold text-ink">
          这个标签页的链路
        </h3>
        <p class="m-0 max-w-prose text-sm text-ink-muted">
          本页面自己持有的 WebSocket 与引导结果。
        </p>
      </div>

      <ul class="m-0 flex list-none flex-col gap-2 p-0">
        <li
          v-for="check in linkChecks"
          :key="check.label"
          class="flex flex-col gap-1 rounded-sm border border-border bg-surface p-3"
        >
          <div class="flex items-baseline gap-2">
            <span class="text-sm text-ink-muted">{{ check.label }}</span>
            <span class="ml-auto flex items-center gap-1.5">
              <span
                class="size-2 shrink-0 rounded-full"
                :class="TONE_DOT[check.tone]"
                aria-hidden="true"
              />
              <strong class="text-sm text-ink">{{ check.value }}</strong>
            </span>
          </div>
          <p class="m-0 text-xs text-ink-muted">{{ check.detail }}</p>
        </li>
      </ul>
    </section>

    <div class="grid gap-3 lg:grid-cols-2">
      <section
        class="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-4"
        aria-labelledby="fleet-heading"
      >
        <h3
          id="fleet-heading"
          class="font-mono text-2xs tracking-wider text-ink-subtle uppercase"
        >
          车队快照
        </h3>
        <dl class="m-0 flex flex-col gap-1">
          <div
            v-for="row in fleetRows"
            :key="row.label"
            class="flex items-baseline justify-between gap-3"
          >
            <dt class="shrink-0 text-xs text-ink-muted">{{ row.label }}</dt>
            <dd class="m-0 truncate font-mono text-sm text-ink">
              {{ row.value }}
            </dd>
          </div>
        </dl>
      </section>

      <section
        class="flex flex-col gap-2 rounded-md border border-border bg-surface-raised p-4"
        aria-labelledby="clock-heading"
      >
        <h3
          id="clock-heading"
          class="font-mono text-2xs tracking-wider text-ink-subtle uppercase"
        >
          两个时钟
        </h3>
        <dl class="m-0 flex flex-col gap-1">
          <div
            v-for="row in clockRows"
            :key="row.label"
            class="flex items-baseline justify-between gap-3"
          >
            <dt class="shrink-0 text-xs text-ink-muted">{{ row.label }}</dt>
            <dd class="m-0 truncate font-mono text-sm text-ink">
              {{ row.value }}
            </dd>
          </div>
        </dl>
        <!-- Both clocks are shown because a skewed browser otherwise reads as a
             stale fleet — the mistake the top bar's relative time used to make. -->
        <p class="m-0 text-xs text-ink-muted">
          两者持续拉大说明本机时钟偏了，而不是车队不再上报。
        </p>
      </section>
    </div>

    <section
      class="flex flex-col gap-3 rounded-md border border-border bg-surface-raised p-4"
      aria-labelledby="local-heading"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <h3 id="local-heading" class="text-lg font-semibold text-ink">
            本浏览器留存的数据
          </h3>
          <p class="m-0 max-w-prose text-sm text-ink-muted">
            按 <code class="font-mono text-xs">navfleet:</code>
            前缀扫描得出，不是写死的清单 ——
            这一页要说的是实情，而写死的清单会过期。
          </p>
        </div>
        <UiButton
          variant="secondary"
          size="sm"
          :disabled="!stored.length || clearing"
          @click="clearLocal"
        >
          清除并重新加载
        </UiButton>
      </div>

      <p v-if="!stored.length" class="m-0 text-sm text-ink-muted" role="status">
        这个浏览器没有留存任何 NavFleet 数据。
      </p>

      <div v-else class="overflow-auto rounded-sm border border-border">
        <table class="w-full border-collapse text-left text-sm">
          <caption class="sr-only">
            本浏览器留存的 NavFleet 数据，共
            {{
              stored.length
            }}
            项
          </caption>
          <thead class="bg-surface-sunken text-2xs text-ink-muted uppercase">
            <tr>
              <th scope="col" class="px-3 py-2 font-medium">项目</th>
              <th scope="col" class="px-3 py-2 font-medium">存续</th>
              <th scope="col" class="px-3 py-2 font-medium">值</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in stored"
              :key="entry.key"
              class="border-t border-border"
            >
              <th scope="row" class="px-3 py-1.5 font-normal">
                <span class="block text-sm text-ink">{{ entry.label }}</span>
                <span class="block font-mono text-2xs text-ink-subtle">{{
                  entry.key
                }}</span>
              </th>
              <td class="px-3 py-1.5 text-xs whitespace-nowrap text-ink-muted">
                {{ AREA_LABELS[entry.area] }}
              </td>
              <td class="px-3 py-1.5 font-mono text-xs break-all text-ink">
                {{ entry.value
                }}<span v-if="entry.truncated" class="text-ink-subtle"
                  >…（已截断）</span
                >
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="m-0 text-xs text-ink-muted">
        清除后页面会重新加载：写入这些键的模块只在加载时读一次，不重载的话旧偏好会继续生效。
      </p>
    </section>
  </PageHeader>
</template>
