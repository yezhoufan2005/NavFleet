<script setup lang="ts">
/**
 * The GPS map: AMap (高德地图) with one marker per vehicle that reports a fix.
 *
 * Ported from v1.0.0's `GpsMap.vue`. Three things changed:
 *
 * - **`useTheme()` is destructured as `{ resolved }`**, not `{ state }`. The old
 *   component read `state.resolved`; this console's composable exposes the resolved
 *   theme directly, and porting the old call unchanged would have failed at runtime
 *   with a perfectly healthy-looking template.
 * - **Marker colours come from tokens.** They are set in an unscoped style block on
 *   purpose — see the note above it.
 * - **The SDK is typed structurally.** AMap ships no types here, so rather than
 *   `any` everywhere there are minimal interfaces for the handful of methods used;
 *   anything outside them is a compile error rather than a runtime surprise.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DeviceSnapshot } from "@navfleet/shared";
import {
  deviceToneLabels,
  getDeviceTone,
  wgs84ToGcj02,
} from "@navfleet/fleet-core";
import { getAmapConfigError, hasAmapConfig, loadAmap } from "@/lib/amap";
import { useTheme } from "@/composables/useTheme";

type LngLat = [number, number];

interface AmapMarker {
  setPosition: (position: LngLat) => void;
  setContent: (content: HTMLElement) => void;
  setzIndex: (index: number) => void;
  on: (event: "click", handler: () => void) => void;
}

interface AmapMap {
  setMapStyle?: (style: string) => void;
  setZoomAndCenter: (
    zoom: number,
    center: LngLat,
    immediately?: boolean,
    duration?: number,
  ) => void;
  setFitView: (
    markers: AmapMarker[],
    immediately?: boolean,
    padding?: number[],
    maxZoom?: number,
  ) => void;
  getZoom: () => number;
  setZoom: (zoom: number, immediately?: boolean, duration?: number) => void;
  add: (marker: AmapMarker) => void;
  remove: (marker: AmapMarker) => void;
  addControl: (control: unknown) => void;
  destroy: () => void;
}

interface AmapNamespace {
  Map: new (
    container: HTMLElement,
    options: Record<string, unknown>,
  ) => AmapMap;
  Marker: new (options: Record<string, unknown>) => AmapMarker;
  Scale: new () => unknown;
  ToolBar: new (options: Record<string, unknown>) => unknown;
}

const { devices, selectedDeviceId } = defineProps<{
  devices: DeviceSnapshot[];
  selectedDeviceId: string;
}>();

const emit = defineEmits<{ select: [deviceId: string] }>();
const { resolved } = useTheme();
const amapStyle = computed(() =>
  resolved.value === "light"
    ? "amap://styles/whitesmoke"
    : "amap://styles/darkblue",
);

const mapRoot = ref<HTMLDivElement | null>(null);
const isLoading = ref(false);
const mapError = ref("");

let map: AmapMap | null = null;
let markerCtor: AmapNamespace["Marker"] | null = null;
const markerEntries = new Map<
  string,
  { marker: AmapMarker; position: LngLat; signature: string }
>();
let lastSelectedDeviceId = "";
/**
 * The fleet is framed once, when the first vehicles arrive. After that the viewport
 * belongs to whoever is looking at it — re-fitting on every device-set change (the
 * demo fleet has a vehicle that goes offline and back) yanked the map away mid-pan.
 */
let hasFittedOnce = false;

watch(amapStyle, (style) => {
  map?.setMapStyle?.(style);
});

const gpsDevices = computed(() =>
  devices.filter(
    (device) =>
      device.gpsEnabled !== false &&
      Number.isFinite(device.gps?.lat) &&
      Number.isFinite(device.gps?.lng),
  ),
);

const hasConfig = computed(() => hasAmapConfig());
const emptyStateMessage = computed(() => {
  if (!hasConfig.value) return getAmapConfigError();
  if (!gpsDevices.value.length) {
    return "当前 MQTT 数据还没有可用的 GPS 经纬度字段。";
  }
  return "";
});

/**
 * The marker DOM. Built imperatively because AMap takes an element, not a component.
 *
 * `gps.heading` is a compass bearing (0 = north, clockwise), which is exactly what a
 * CSS rotation of an upward-pointing arrow wants — no conversion.
 */
const createMarkerContent = (
  device: DeviceSnapshot,
  tone: string,
  selected: boolean,
): HTMLElement => {
  const root = document.createElement("div");
  root.className = `amap-device-marker tone-${tone}${selected ? " is-selected" : ""}`;

  if (Number.isFinite(device.gps?.heading)) {
    root.style.setProperty("--heading", `${device.gps!.heading}deg`);
    const heading = document.createElement("div");
    heading.className = "amap-device-heading";
    root.appendChild(heading);
  }

  const pin = document.createElement("div");
  pin.className = "amap-device-pin";

  const label = document.createElement("div");
  label.className = "amap-device-label";
  const title = document.createElement("strong");
  title.textContent = device.deviceName || device.deviceId;
  const meta = document.createElement("span");
  meta.textContent = `${deviceToneLabels[tone as keyof typeof deviceToneLabels] ?? "正常"} / ${device.deviceId}`;
  label.append(title, meta);

  root.append(pin, label);
  return root;
};

/** Everything a marker's appearance depends on — the redraw key. */
const signatureOf = (device: DeviceSnapshot, tone: string, selected: boolean) =>
  `${tone}|${selected ? 1 : 0}|${device.deviceName}|${device.deviceId}|${device.gps?.heading ?? ""}`;

const destroyMarkers = (): void => {
  markerEntries.forEach((entry) => map?.remove(entry.marker));
  markerEntries.clear();
  lastSelectedDeviceId = "";
  hasFittedOnce = false;
};

/** Frame the whole fleet. First load, and the toolbar button. */
/** Steps the zoom by one level, clamped to the `zooms` range the map was created with. */
const stepZoom = (delta: number): void => {
  if (!map) return;
  const next = Math.min(20, Math.max(3, (map.getZoom() || 3) + delta));
  map.setZoom(next, false, 200);
};

const fitFleet = (): void => {
  if (!map || !markerEntries.size) return;

  const entries = [...markerEntries.values()];
  const only = entries[0];
  if (entries.length === 1 && only) {
    map.setZoomAndCenter(16, only.position, false, 300);
    return;
  }
  map.setFitView(
    entries.map((entry) => entry.marker),
    false,
    [64, 72, 64, 72],
    16,
  );
};

/** Animate to the picked vehicle, keeping at least street-level zoom. */
const focusSelected = (): void => {
  const entry = selectedDeviceId ? markerEntries.get(selectedDeviceId) : null;
  if (!map || !entry) return;
  map.setZoomAndCenter(
    Math.max(map.getZoom() || 0, 16),
    entry.position,
    false,
    300,
  );
};

const syncMarkers = (): void => {
  if (!map || !markerCtor) return;

  const nextIds = new Set(gpsDevices.value.map((device) => device.deviceId));
  markerEntries.forEach((entry, deviceId) => {
    if (!nextIds.has(deviceId)) {
      map?.remove(entry.marker);
      markerEntries.delete(deviceId);
    }
  });

  gpsDevices.value.forEach((device) => {
    const position = wgs84ToGcj02(
      device.gps!.lng as number,
      device.gps!.lat as number,
    ) as LngLat;
    if (!position) return;

    const tone = getDeviceTone(device);
    const selected = device.deviceId === selectedDeviceId;
    const signature = signatureOf(device, tone, selected);
    const existing = markerEntries.get(device.deviceId);

    if (existing) {
      existing.marker.setPosition(position);
      if (existing.signature !== signature) {
        existing.marker.setContent(createMarkerContent(device, tone, selected));
        existing.signature = signature;
      }
      existing.marker.setzIndex(selected ? 160 : 110);
      existing.position = position;
      return;
    }

    const marker = new markerCtor!({
      position,
      // The content's box is the pin and the coordinate is its centre, so no pixel
      // offset is wanted: a constant screen offset would put the vehicle a
      // zoom-dependent distance from where it actually is.
      anchor: "center",
      content: createMarkerContent(device, tone, selected),
      zIndex: selected ? 160 : 110,
    });

    marker.on("click", () => emit("select", device.deviceId));
    map?.add(marker);
    markerEntries.set(device.deviceId, { marker, position, signature });
  });

  if (!hasFittedOnce && markerEntries.size) {
    fitFleet();
    hasFittedOnce = true;
  } else if (selectedDeviceId !== lastSelectedDeviceId) {
    focusSelected();
  }
  lastSelectedDeviceId = selectedDeviceId;
};

const initializeMap = async (): Promise<void> => {
  if (!hasConfig.value || !mapRoot.value) return;

  isLoading.value = true;
  mapError.value = "";

  try {
    const AMap = (await loadAmap()) as AmapNamespace;
    if (!mapRoot.value) return;

    map = new AMap.Map(mapRoot.value, {
      viewMode: "2D",
      zoom: 11,
      center: [121.4737, 31.2304],
      mapStyle: amapStyle.value,
      resizeEnable: true,
      zooms: [3, 20],
    });

    markerCtor = AMap.Marker;
    /*
     * No `AMap.ToolBar`. Its zoom widget is AMap's own chrome — a bright chunk bottom-right
     * that ignores the design tokens, so on the dark theme it is a lit rectangle sitting on
     * a dark map. The two buttons below do the same job in the same style as 适应车队.
     *
     * `AMap.Scale` **stays**, and that is not the same call: it is the only distance readout
     * this surface has, and replacing it means projecting metres per pixel at the current
     * latitude — real work, and a capability v1.0.0 also leaned on AMap for. Removing it to
     * satisfy a theming complaint would trade a working control for a missing one. (The
     * scene map's scale bar is a different matter: its world units are already metres.)
     */
    map.addControl(new AMap.Scale());

    syncMarkers();
  } catch (error) {
    mapError.value =
      error instanceof Error ? error.message : "高德地图加载失败。";
  } finally {
    isLoading.value = false;
  }
};

onMounted(() => {
  void initializeMap();
});

onBeforeUnmount(() => {
  destroyMarkers();
  map?.destroy();
  map = null;
  markerCtor = null;
});

/**
 * Everything the markers derive from, as one comparable string.
 *
 * This watcher used to be `{ deep: true }` over the device array. The parent hands
 * down a fresh array on every telemetry tick, so that walked every device's entire
 * object graph — pose, vehicleInfo, three code blocks, the alert list — once per
 * second per device, to decide whether to redraw. Marker rendering depends on six
 * fields, so comparing those directly is both cheaper and more selective: a tick that
 * only moved `soc` now redraws nothing.
 */
const markerSignature = computed(() => {
  const list = gpsDevices.value
    .map(
      (device) =>
        `${device.deviceId}|${device.gps!.lat}|${device.gps!.lng}|${device.gps?.heading}|${getDeviceTone(device)}|${device.deviceName}`,
    )
    .join(";");
  return `${list}#${selectedDeviceId}`;
});

watch(markerSignature, () => {
  syncMarkers();
});
</script>

<template>
  <div class="relative min-h-0 flex-1 overflow-hidden">
    <div
      v-if="!hasConfig || mapError"
      class="absolute inset-0 grid place-content-center justify-items-center gap-2 bg-surface-sunken px-6 text-center"
    >
      <span
        class="rounded-xs bg-offline-wash px-2 py-1 font-mono text-2xs text-offline-ink"
        >GPS</span
      >
      <strong class="text-md text-ink">{{
        mapError ? "高德地图加载失败" : "等待 GPS 地图接入"
      }}</strong>
      <span class="max-w-96 text-sm text-ink-muted">{{
        mapError || emptyStateMessage
      }}</span>
    </div>

    <template v-else>
      <div
        ref="mapRoot"
        class="size-full"
        role="img"
        aria-label="GPS 设备位置分布地图"
      />

      <div
        v-if="gpsDevices.length && !isLoading"
        class="absolute top-2 right-2 flex gap-2"
      >
        <button
          type="button"
          class="rounded-xs border border-border-strong bg-surface-raised px-2.5 py-1 text-xs text-ink-muted transition-colors duration-150 ease-standard hover:text-ink"
          @click="fitFleet"
        >
          适应车队
        </button>
        <!-- Replacing `AMap.ToolBar`'s zoom, in this surface's own styling. `aria-label`
             rather than a bare glyph: `+` and `−` are punctuation to a screen reader. -->
        <button
          type="button"
          class="rounded-xs border border-border-strong bg-surface-raised px-2.5 py-1 text-xs text-ink-muted transition-colors duration-150 ease-standard hover:text-ink"
          aria-label="放大"
          @click="stepZoom(1)"
        >
          ＋
        </button>
        <button
          type="button"
          class="rounded-xs border border-border-strong bg-surface-raised px-2.5 py-1 text-xs text-ink-muted transition-colors duration-150 ease-standard hover:text-ink"
          aria-label="缩小"
          @click="stepZoom(-1)"
        >
          －
        </button>
      </div>

      <div
        v-if="isLoading || !gpsDevices.length"
        class="pointer-events-none absolute inset-0 grid place-content-center gap-1 px-6 text-center"
        role="status"
      >
        <strong class="text-md text-ink">{{
          isLoading ? "正在加载高德地图" : "暂无设备 GPS 数据"
        }}</strong>
        <span class="text-sm text-ink-muted">{{
          isLoading ? "地图底图和设备点位初始化中，请稍候。" : emptyStateMessage
        }}</span>
      </div>
    </template>
  </div>
</template>

<!--
  Unscoped on purpose. The marker DOM is built with `document.createElement` and
  handed to AMap, so it never receives Vue's scope attribute — a `scoped` block
  would compile to selectors that match nothing. The `amap-device-` prefix is what
  keeps that safe.
-->
<style>
.amap-device-marker {
  position: relative;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  --marker-color: var(--color-offline);
}
.amap-device-marker.tone-normal {
  --marker-color: var(--color-brand);
}
.amap-device-marker.tone-notice {
  --marker-color: var(--color-notice);
}
.amap-device-marker.tone-warning {
  --marker-color: var(--color-warning);
}
.amap-device-marker.tone-critical {
  --marker-color: var(--color-critical);
}

.amap-device-pin {
  width: 12px;
  height: 12px;
  border-radius: 999px;
  background: var(--marker-color);
  box-shadow: 0 0 0 2px var(--color-surface-raised);
}
/*
 * The selected pin: static emphasis **plus** a pulse, not one or the other.
 *
 * The size step and the second ring are what a still screenshot needs; the pulse is what a
 * moving fleet needs — v1.0.0 expressed selection as motion (`pulse 2s ease-in-out
 * infinite` on the pin itself) and the port replaced it with geometry, which reads fine
 * next to one marker and disappears in a cluster of forty.
 *
 * The animation is on the *ring* spread rather than on the pin's `width`/`height`, unlike
 * v1.0.0's `transform: scale(1.12)`: this marker is `display: grid; place-items: center`,
 * so growing the pin moves its own box and drags the label 20px below it up and down once
 * per cycle. `box-shadow` spread costs no layout.
 *
 * No reduced-motion block — `styles/base.css:67-78` holds a global `!important` kill
 * switch, and it reaches here despite this being an unscoped block because a layered
 * `!important` outranks an unlayered declaration.
 */
.amap-device-marker.is-selected .amap-device-pin {
  width: 16px;
  height: 16px;
  box-shadow:
    0 0 0 2px var(--color-surface-raised),
    0 0 0 5px color-mix(in oklch, var(--marker-color) 40%, transparent);
  animation: amap-pin-pulse 2s ease-out infinite;
}

@keyframes amap-pin-pulse {
  0% {
    box-shadow:
      0 0 0 2px var(--color-surface-raised),
      0 0 0 5px color-mix(in oklch, var(--marker-color) 40%, transparent);
  }
  70% {
    box-shadow:
      0 0 0 2px var(--color-surface-raised),
      0 0 0 14px color-mix(in oklch, var(--marker-color) 0%, transparent);
  }
  100% {
    box-shadow:
      0 0 0 2px var(--color-surface-raised),
      0 0 0 5px color-mix(in oklch, var(--marker-color) 0%, transparent);
  }
}

.amap-device-heading {
  position: absolute;
  inset: 0;
  transform: rotate(var(--heading, 0deg));
}
.amap-device-heading::before {
  content: "";
  position: absolute;
  top: -10px;
  left: 50%;
  translate: -50% 0;
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  border-bottom: 8px solid var(--marker-color);
}

/*
 * The label, with the two defensive rules v1.0.0 had and the port dropped. Both are the
 * kind that show nothing on a quiet map and everything on a busy one:
 *
 * 1. **`pointer-events: none` + `visibility: hidden`.** At `opacity: 0` alone the card is
 *    still hit-testable, so an invisible box sits 20px under every pin and swallows clicks
 *    aimed at whatever marker is behind it. `opacity` was doing the *looking* hidden and
 *    nothing was doing the *being* hidden.
 * 2. **`z-index` on the hovered marker** (below). v1.0.0's comment on this said it plainly:
 *    without it, a label in a dense cluster renders behind the neighbouring pins — i.e. the
 *    hover does something and you cannot read the result.
 *
 * `max-width` too: `white-space: nowrap` with no clamp lets one long device name produce an
 * unbounded card. v1.0.0 clamped 132–220px.
 */
.amap-device-label {
  position: absolute;
  top: 20px;
  left: 50%;
  translate: -50% 0;
  display: grid;
  gap: 1px;
  padding: 3px 7px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-xs);
  background: var(--color-surface-raised);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition:
    opacity 150ms var(--ease-standard),
    visibility 150ms var(--ease-standard);
}

/* Lifts the whole marker, not just the label — the pins are siblings, so the label can
   only clear them if its own marker outranks them. */
.amap-device-marker:hover {
  z-index: 200;
}
.amap-device-marker.is-selected .amap-device-label,
.amap-device-marker:hover .amap-device-label {
  opacity: 1;
  visibility: visible;
}
.amap-device-label strong {
  font-size: var(--text-xs);
  color: var(--color-ink);
}
.amap-device-label span {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  color: var(--color-ink-muted);
}
</style>
