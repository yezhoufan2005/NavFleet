<script setup lang="ts">
/**
 * 设备详情 — a route, not a nav section, and the frame its four tabs share.
 *
 * Reached from the list, the map or an alert. It is where the 11B audit found the
 * worst task flow in v1.0.0: diagnosing one vehicle took six steps and still did not
 * answer the question, because live telemetry and history lived on different pages and
 * each made you pick the device again. Here they are one page over an already-chosen
 * device.
 *
 * ## Why tabs, and why they are real routes
 *
 * `docs/frontend-ia.md` puts 实时 / 曲线 / 回放 / 消息史 here rather than in the nav,
 * because a separate page made you choose the same vehicle twice. They are answers to
 * different questions asked at different times — right now / lately / that afternoon /
 * has this happened before — so stacking them into one scroll would bury the first.
 *
 * They are **child routes**, not a `?tab=` on one view (the shape 消息 / 用户 / 部署
 * use). This component is the shell: it owns the device header and the tab strip and
 * renders the active tab into its `<RouterView>`. The payoff is that the breadcrumb
 * reads 设备 › <id> › 实时, Back/Forward walk the tabs, and "look at c12's playback" is
 * a URL rather than a sentence with a step in it. Each tab's component is a lazy route
 * import, so arriving at 实时 still downloads none of ECharts or the map engine — the
 * split point and the "do we need this yet" point remain the same line.
 */
import { computed } from "vue";
import { useRoute } from "vue-router";
import PageHeader from "@/components/PageHeader.vue";
import AppSectionTabs from "@/components/shell/AppSectionTabs.vue";
import { useFleetStore } from "@/stores/fleet";
import { deviceToneLabels, getDeviceTone } from "@navfleet/fleet-core";

const route = useRoute();
const fleet = useFleetStore();

const deviceId = computed(() => String(route.params.deviceId ?? ""));
const device = computed(() => fleet.state.devicesById[deviceId.value] ?? null);

const tone = computed(() =>
  device.value ? getDeviceTone(device.value) : "offline",
);
const toneLabel = computed(() => deviceToneLabels[tone.value]);

const TONE_BADGE: Record<string, string> = {
  normal: "bg-brand-wash text-brand-ink",
  notice: "bg-notice-wash text-notice-ink",
  warning: "bg-warning-wash text-warning-ink",
  critical: "bg-critical-wash text-critical-ink",
  offline: "bg-offline-wash text-offline-ink",
};
</script>

<template>
  <PageHeader
    :title="device ? device.deviceName || deviceId : `设备 ${deviceId}`"
  >
    <!-- The device id reads beside the name rather than under it (Phase 18 polish):
         「A01 巡检车  agv-a01」, dropping the earlier 「编号」 lede. -->
    <template v-if="device" #titleSuffix>
      <span class="font-mono text-sm text-ink-muted">{{
        device.deviceId
      }}</span>
    </template>

    <template #actions>
      <span
        v-if="device"
        class="rounded-xs px-2 py-1 font-mono text-2xs"
        :class="TONE_BADGE[tone]"
        >{{ toneLabel }}</span
      >
    </template>

    <div
      v-if="!device"
      class="grid place-content-center gap-2 rounded-md border border-border bg-surface-raised p-10 text-center"
    >
      <strong class="text-md text-ink">{{
        fleet.bootstrapPending ? "正在加载车队…" : "找不到这台设备"
      }}</strong>
      <span class="text-sm text-ink-muted">{{
        fleet.bootstrapPending
          ? "正在获取车队快照"
          : `车队快照里没有编号为 ${deviceId} 的设备，它可能已被移除或从未上报`
      }}</span>
    </div>

    <template v-else>
      <!-- Same strip as every multi-tab section: `AppSectionTabs` reads the four tabs
           off this route's `meta.tabs`, and its `-mt-4` seats them directly under the
           title with no gap of their own. -->
      <AppSectionTabs />
      <RouterView />
    </template>
  </PageHeader>
</template>
