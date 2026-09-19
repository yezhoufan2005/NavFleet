<script setup lang="ts">
/**
 * 大屏值班 — a mode, not a section, which is why it is not in the navigation.
 *
 * Nobody "navigates to the wall display": a screen is mounted, pointed at this
 * address once with a kiosk credential (Phase 17C), and left for months. Everything
 * about it follows from that (`docs/frontend-ia.md` §4):
 *
 * - **No shell.** `meta.bare` (see the router) keeps the sidebar, top bar and session
 *   menu off the screen, and the whole page is `pointer-events: none` — a wall is
 *   watched from across a room, not operated, so a cursor, a hover state or a stray
 *   click has nothing to do here.
 * - **A freshness indicator is mandatory, not decorative.** A frozen screen and a
 *   quiet fleet look identical from two metres, so the corner carries "数据 N 秒前更新"
 *   that must visibly move every second, plus a colour that turns amber then red as
 *   the gap grows (`wallFreshness`). The socket, the bootstrap and the refresh that
 *   keeps the kiosk session alive are all owned by `App.vue` and run for this bare
 *   route too, so the view only reads the store.
 * - **Readable at two metres**, on the `text-wall-*` scale, and **nothing important in
 *   the bottom third** — a display wall's lower edge sits around 1.2m and the front
 *   row of equipment blocks it, so the KPI band, freshness and alert stream all live
 *   up top and the map takes the slack below.
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import GpsMap from "@/components/map/GpsMap.vue";
import { useFleetStore } from "@/stores/fleet";
import { formatDateTime } from "@navfleet/fleet-core";
import type { Severity } from "@navfleet/shared";
import {
  buildWallTiles,
  flattenActiveAlerts,
  wallFreshness,
  type WallTone,
} from "@/lib/wallView";

/** One second, no "刚刚" band: a freshness number that does not move reads as frozen. */
const AGE_TICK_MS = 1_000;

const fleet = useFleetStore();

const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

const freshness = computed(() =>
  wallFreshness(fleet.state.lastUpdateAt, now.value),
);

/** The freshness pill carries three signals at once so it never leans on colour alone:
 * a coloured dot, a word (实时 / 数据延迟 / 画面可能已冻结) and the moving age line below it. */
const FRESHNESS_PILL: Record<WallTone, string> = {
  ok: "bg-surface-raised text-ink",
  warning: "bg-warning-wash text-warning-ink",
  critical: "bg-critical-wash text-critical-ink",
};
const FRESHNESS_DOT: Record<WallTone, string> = {
  ok: "bg-brand",
  warning: "bg-warning",
  critical: "bg-critical",
};
const FRESHNESS_WORD: Record<WallTone, string> = {
  ok: "实时",
  warning: "数据延迟",
  critical: "画面可能已冻结",
};

const serverTimeLabel = computed(() =>
  fleet.state.serverUpdatedAt
    ? formatDateTime(fleet.state.serverUpdatedAt)
    : "--",
);

const tiles = computed(() =>
  buildWallTiles(
    {
      totalCount: fleet.summary.totalCount,
      onlineCount: fleet.summary.onlineCount,
      alertTotal: fleet.summary.alertTotal,
      gpsCount: fleet.summary.gpsCount,
    },
    fleet.groupedAlerts.critical.length,
    fleet.formations.length,
  ),
);

const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "告警",
  warning: "预警",
  notice: "提示",
};
const SEVERITY_BADGE: Record<Severity, string> = {
  critical: "bg-critical-wash text-critical-ink",
  warning: "bg-warning-wash text-warning-ink",
  notice: "bg-notice-wash text-notice-ink",
};

const activeAlerts = computed(() => flattenActiveAlerts(fleet.groupedAlerts));

/**
 * The alert stream auto-scrolls only when it overflows its column — measured, because
 * a wall cannot be scrolled by hand (`pointer-events: none`) and a short list must sit
 * still rather than drift. When scrolling, a second copy of the list rides below the
 * first and the track translates a full -50%, landing exactly on the clone for a seamless
 * loop; `prefers-reduced-motion` (handled globally) parks it at the top, worst-first.
 */
const viewport = ref<HTMLElement | null>(null);
const list = ref<HTMLElement | null>(null);
const scrolling = ref(false);
let observer: ResizeObserver | null = null;

const measure = (): void => {
  const vp = viewport.value;
  const listEl = list.value;
  scrolling.value =
    !!vp && !!listEl && listEl.scrollHeight > vp.clientHeight + 1;
};

/** Slower with more rows, so per-row dwell stays roughly constant and readable at 2m. */
const scrollSeconds = computed(() =>
  Math.max(24, activeAlerts.value.length * 6),
);

onMounted(() => {
  ticker = setInterval(() => {
    now.value = Date.now();
  }, AGE_TICK_MS);
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => measure());
    if (viewport.value) observer.observe(viewport.value);
    if (list.value) observer.observe(list.value);
  }
  void nextTick(measure);
});

onBeforeUnmount(() => {
  if (ticker !== null) clearInterval(ticker);
  observer?.disconnect();
});

// Re-measure when the set of alerts changes: a burst can push a fitting list into overflow.
watch(activeAlerts, () => {
  void nextTick(measure);
});
</script>

<template>
  <main class="wall-root select-none" aria-label="车队大屏值班">
    <div class="wall-header">
      <div class="wall-title">
        <span class="wall-eyebrow">车队大屏值班</span>
        <h1 class="wall-fleet-name">{{ fleet.state.fleetName }}</h1>
      </div>
      <div class="wall-freshness">
        <span class="wall-pill" :class="FRESHNESS_PILL[freshness.tone]">
          <span
            class="wall-pill-dot"
            :class="FRESHNESS_DOT[freshness.tone]"
            aria-hidden="true"
          />
          <span>{{ FRESHNESS_WORD[freshness.tone] }}</span>
        </span>
        <div class="wall-freshness-meta">
          <span class="wall-age">{{ freshness.ageLabel }}</span>
          <span class="wall-server"
            >服务端 {{ serverTimeLabel }} · {{ fleet.connection.label }}</span
          >
        </div>
      </div>
    </div>

    <section class="wall-kpi" aria-label="车队概览">
      <article
        v-for="tile in tiles"
        :key="tile.key"
        class="wall-tile"
        :data-tone="tile.tone"
      >
        <span class="wall-tile-label">{{ tile.label }}</span>
        <strong class="wall-tile-value">{{ tile.value }}</strong>
        <span class="wall-tile-note">{{ tile.note }}</span>
      </article>
    </section>

    <div class="wall-body">
      <section class="wall-map" aria-label="车队位置">
        <GpsMap :devices="fleet.sortedDevices" selected-device-id="" />
      </section>

      <aside class="wall-alerts" aria-label="活跃告警">
        <h2 class="wall-alerts-title">
          活跃告警<span class="wall-alerts-count">{{
            activeAlerts.length
          }}</span>
        </h2>
        <p v-if="activeAlerts.length === 0" class="wall-alerts-empty">
          全部正常，当前无活跃告警
        </p>
        <div v-else ref="viewport" class="wall-alerts-viewport">
          <div
            class="wall-alerts-track"
            :class="{ 'wall-alerts-track--scroll': scrolling }"
            :style="{ '--wall-scroll-duration': scrollSeconds + 's' }"
          >
            <ul ref="list" class="wall-alerts-list">
              <li
                v-for="alert in activeAlerts"
                :key="alert.deviceId + ':' + alert.id"
                class="wall-alert"
              >
                <span
                  class="wall-alert-badge"
                  :class="SEVERITY_BADGE[alert.severity]"
                  >{{ SEVERITY_LABELS[alert.severity] }}</span
                >
                <span class="wall-alert-body">
                  <span class="wall-alert-headline">{{ alert.title }}</span>
                  <span class="wall-alert-meta"
                    >{{ alert.deviceName }} ·
                    {{ formatDateTime(alert.firstSeenAt) }}</span
                  >
                </span>
              </li>
            </ul>
            <ul v-if="scrolling" class="wall-alerts-list" aria-hidden="true">
              <li
                v-for="alert in activeAlerts"
                :key="'clone:' + alert.deviceId + ':' + alert.id"
                class="wall-alert"
              >
                <span
                  class="wall-alert-badge"
                  :class="SEVERITY_BADGE[alert.severity]"
                  >{{ SEVERITY_LABELS[alert.severity] }}</span
                >
                <span class="wall-alert-body">
                  <span class="wall-alert-headline">{{ alert.title }}</span>
                  <span class="wall-alert-meta"
                    >{{ alert.deviceName }} ·
                    {{ formatDateTime(alert.firstSeenAt) }}</span
                  >
                </span>
              </li>
            </ul>
          </div>
        </div>
      </aside>
    </div>
  </main>
</template>

<!-- WALL_STYLE -->

<style scoped>
/* A wall is watched, not operated: the whole surface ignores the pointer, which also
   neutralises the map's own zoom controls without reaching into that component. */
.wall-root {
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: clamp(0.75rem, 1.6vh, 1.75rem);
  min-height: 100dvh;
  /* Extra bottom room on purpose — the lower third of a wall is blocked by the front
     row of equipment, so nothing important is allowed to land there. */
  padding: clamp(1rem, 2.4vh, 2.5rem) clamp(1rem, 2.4vw, 2.5rem)
    clamp(2.5rem, 9vh, 6rem);
  background: var(--color-surface);
  color: var(--color-ink);
  pointer-events: none;
  overflow: hidden;
}

/* A near-imperceptible, very slow drift so a screen left on for months does not burn a
   fixed layout into an OLED panel. Motion-sensitive users (and the axe run) get none. */
@media (prefers-reduced-motion: no-preference) {
  .wall-root {
    animation: wall-drift 900s ease-in-out infinite alternate;
  }
}
@keyframes wall-drift {
  from {
    transform: translate(0, 0);
  }
  to {
    transform: translate(3px, 2px);
  }
}

.wall-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
}
.wall-eyebrow {
  font-size: var(--text-wall-sm);
  color: var(--color-ink-subtle);
}
.wall-fleet-name {
  font-size: var(--text-wall-xl);
  font-weight: 600;
  line-height: 1.1;
}
.wall-freshness {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.wall-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: 9999px;
  padding: 0.35em 0.9em;
  font-size: var(--text-wall-base);
  font-weight: 600;
}
.wall-pill-dot {
  width: 0.7em;
  height: 0.7em;
  border-radius: 9999px;
}
.wall-freshness-meta {
  display: flex;
  flex-direction: column;
  text-align: right;
}
.wall-age {
  font-size: var(--text-wall-base);
  font-variant-numeric: tabular-nums;
  color: var(--color-ink);
}
.wall-server {
  font-size: var(--text-wall-sm);
  color: var(--color-ink-subtle);
}

.wall-kpi {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: clamp(0.75rem, 1.4vw, 1.5rem);
}
.wall-tile {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 0.85rem;
  background: var(--color-surface-raised);
  padding: clamp(0.75rem, 1.5vh, 1.5rem) clamp(1rem, 1.8vw, 2rem);
  /* The tone is a stripe, not a wash: text wears text colour, a saturated mark beside it
     carries the state (the rule this project's charts and 总览 already follow). Colour
     only appears when the number is off — a permanently amber tile trains the room to
     ignore amber, so ok/muted get a neutral stripe. */
  box-shadow: inset 6px 0 0 var(--color-border-strong);
}
.wall-tile[data-tone="warning"] {
  box-shadow: inset 6px 0 0 var(--color-warning);
}
.wall-tile[data-tone="critical"] {
  box-shadow: inset 6px 0 0 var(--color-critical);
}
.wall-tile-label {
  font-size: var(--text-wall-sm);
  color: var(--color-ink-muted);
}
.wall-tile-value {
  font-size: var(--text-wall-xl);
  font-weight: 700;
  line-height: 1.05;
  font-variant-numeric: tabular-nums;
  color: var(--color-ink);
}
.wall-tile-note {
  font-size: var(--text-wall-sm);
  color: var(--color-ink-subtle);
}

.wall-body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(20rem, 26vw, 34rem);
  gap: clamp(0.75rem, 1.4vw, 1.5rem);
  min-height: 0;
}
.wall-map {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 0.85rem;
  background: var(--color-surface-raised);
}
/* No zoom/fit affordances on a non-interactive wall — the map fits the fleet on load. */
.wall-map :deep(button) {
  display: none;
}

.wall-alerts {
  display: flex;
  flex-direction: column;
  min-height: 0;
  gap: 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 0.85rem;
  background: var(--color-surface-raised);
  padding: clamp(0.75rem, 1.5vh, 1.5rem) clamp(0.85rem, 1.4vw, 1.5rem);
}
.wall-alerts-title {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: var(--text-wall-base);
  font-weight: 600;
  color: var(--color-ink);
}
.wall-alerts-count {
  border-radius: 9999px;
  background: var(--color-surface-sunken);
  padding: 0.05em 0.6em;
  font-size: var(--text-wall-sm);
  font-variant-numeric: tabular-nums;
  color: var(--color-ink-muted);
}
.wall-alerts-empty {
  display: grid;
  flex: 1;
  place-content: center;
  font-size: var(--text-wall-base);
  color: var(--color-ink-muted);
}
.wall-alerts-viewport {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.wall-alerts-track--scroll {
  animation: wall-scroll var(--wall-scroll-duration, 40s) linear infinite;
}
@keyframes wall-scroll {
  from {
    transform: translateY(0);
  }
  to {
    transform: translateY(-50%);
  }
}
.wall-alerts-list {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.wall-alert {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  border-radius: 0.6rem;
  background: var(--color-surface-sunken);
  padding: 0.6rem 0.8rem;
}
.wall-alert-badge {
  flex-shrink: 0;
  border-radius: 0.4rem;
  padding: 0.15em 0.55em;
  font-size: var(--text-wall-sm);
  font-weight: 600;
}
.wall-alert-body {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.wall-alert-headline {
  font-size: var(--text-wall-sm);
  color: var(--color-ink);
}
.wall-alert-meta {
  font-size: var(--text-sm);
  /* ink-muted, not ink-subtle: this line sits on the sunken alert-row wash, where the lighter
     subtle ink falls to 4.42:1 at 13px — under AA. The muted tier clears it. */
  color: var(--color-ink-muted);
}

/* On a true wall panel the whole scale steps up so it still reads across the room. */
@media (min-width: 2560px) {
  .wall-fleet-name,
  .wall-tile-value {
    font-size: var(--text-wall-2xl);
  }
  .wall-tile-label,
  .wall-tile-note,
  .wall-alert-headline,
  .wall-alert-badge {
    font-size: var(--text-wall-base);
  }
}
</style>
