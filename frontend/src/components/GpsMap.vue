<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { getAmapConfigError, hasAmapConfig, loadAmap } from "../utils/amap";
import { wgs84ToGcj02 } from "../utils/gps";
import { useTheme } from "../composables/useTheme";

const props = defineProps({
  devices: { type: Array, required: true },
  selectedDeviceId: { type: String, default: "" },
  getDeviceTone: { type: Function, required: true },
});

const emit = defineEmits(["select"]);

const { state: themeState } = useTheme();
const amapStyle = computed(() =>
  themeState.resolved === "light" ? "amap://styles/whitesmoke" : "amap://styles/darkblue",
);

const toneLabelMap = {
  normal: "正常",
  warning: "预警",
  critical: "告警",
  notice: "提示",
  offline: "离线",
};

const mapRoot = ref(null);
const isLoading = ref(false);
const mapError = ref("");

let map = null;
let markerCtor = null;
const markerEntries = new Map();
let lastSelectedDeviceId = "";
let lastViewportKey = "";

// Keep the AMap base style in sync with the active light/dark theme.
watch(amapStyle, (style) => {
  if (map && typeof map.setMapStyle === "function") {
    map.setMapStyle(style);
  }
});

const gpsDevices = computed(() =>
  props.devices.filter(
    (device) =>
      device.gpsEnabled !== false &&
      Number.isFinite(device.gps?.lat) &&
      Number.isFinite(device.gps?.lng),
  ),
);

const hasConfig = computed(() => hasAmapConfig());
const emptyStateMessage = computed(() => {
  if (!hasConfig.value) {
    return getAmapConfigError();
  }
  if (!gpsDevices.value.length) {
    return "当前 MQTT 数据还没有可用的 GPS 经纬度字段。";
  }
  return "";
});

function createMarkerContent(device, tone, selected) {
  const root = document.createElement("div");
  root.className = `amap-device-marker tone-${tone}${selected ? " is-selected" : ""}`;

  const pin = document.createElement("div");
  pin.className = "amap-device-pin";
  if (Number.isFinite(device.gps?.heading)) {
    pin.style.setProperty("--heading", `${device.gps.heading}deg`);
  }

  const label = document.createElement("div");
  label.className = "amap-device-label";

  const title = document.createElement("strong");
  title.textContent = device.deviceName || device.deviceId;

  const meta = document.createElement("span");
  meta.textContent = `${toneLabelMap[tone] || "正常"} / ${device.deviceId}`;

  label.appendChild(title);
  label.appendChild(meta);
  root.appendChild(pin);
  root.appendChild(label);
  return root;
}

function buildMarkerPosition(device) {
  return wgs84ToGcj02(device.gps.lng, device.gps.lat);
}

function destroyMarkers() {
  markerEntries.forEach((entry) => {
    if (entry.marker) {
      map?.remove(entry.marker);
    }
  });
  markerEntries.clear();
  lastSelectedDeviceId = "";
  lastViewportKey = "";
}

function fitMapToMarkers(force = false) {
  if (!map || !markerEntries.size) {
    return;
  }

  const viewportKey = [...markerEntries.keys()].sort().join("|");
  const activeMarkers = [...markerEntries.values()].map((entry) => entry.marker);
  const selectedChanged = props.selectedDeviceId !== lastSelectedDeviceId;

  if (!force && viewportKey === lastViewportKey && !selectedChanged) {
    return;
  }

  if (activeMarkers.length === 1) {
    const [lng, lat] = markerEntries.values().next().value.position;
    map.setZoomAndCenter(15, [lng, lat]);
    lastViewportKey = viewportKey;
    lastSelectedDeviceId = props.selectedDeviceId;
    return;
  }

  if (force || viewportKey !== lastViewportKey) {
    map.setFitView(activeMarkers, false, [56, 64, 56, 64], 15);
  } else if (selectedChanged) {
    const selectedEntry = markerEntries.get(props.selectedDeviceId);
    if (selectedEntry) {
      map.panTo(selectedEntry.position);
    }
  }

  lastViewportKey = viewportKey;
  lastSelectedDeviceId = props.selectedDeviceId;
}

function syncMarkers() {
  if (!map || !markerCtor) {
    return;
  }

  let markerSetChanged = false;
  const nextIds = new Set(gpsDevices.value.map((device) => device.deviceId));
  markerEntries.forEach((entry, deviceId) => {
    if (!nextIds.has(deviceId)) {
      map.remove(entry.marker);
      markerEntries.delete(deviceId);
      markerSetChanged = true;
    }
  });

  gpsDevices.value.forEach((device) => {
    const position = buildMarkerPosition(device);
    if (!position) {
      return;
    }

    const tone = props.getDeviceTone(device);
    const selected = device.deviceId === props.selectedDeviceId;
    const existing = markerEntries.get(device.deviceId);

    if (existing) {
      existing.marker.setPosition(position);
      const signature = `${tone}|${selected ? 1 : 0}|${device.deviceName}|${device.deviceId}|${device.gps?.heading ?? ""}`;
      if (existing.signature !== signature) {
        existing.marker.setContent(createMarkerContent(device, tone, selected));
        existing.signature = signature;
      }
      existing.marker.setzIndex(selected ? 160 : 110);
      existing.position = position;
      return;
    }

    const marker = new markerCtor({
      position,
      anchor: "bottom-center",
      offset: new window.AMap.Pixel(0, 8),
      content: createMarkerContent(device, tone, selected),
      zIndex: selected ? 160 : 110,
    });

    marker.on("click", () => emit("select", device.deviceId));
    map.add(marker);
    markerEntries.set(device.deviceId, {
      marker,
      position,
      signature: `${tone}|${selected ? 1 : 0}|${device.deviceName}|${device.deviceId}|${device.gps?.heading ?? ""}`,
    });
    markerSetChanged = true;
  });

  fitMapToMarkers(markerSetChanged);
}

async function initializeMap() {
  if (!hasConfig.value || !mapRoot.value) {
    return;
  }

  isLoading.value = true;
  mapError.value = "";

  try {
    const AMap = await loadAmap();
    if (!mapRoot.value) {
      return;
    }

    map = new AMap.Map(mapRoot.value, {
      viewMode: "2D",
      zoom: 11,
      center: [121.4737, 31.2304],
      mapStyle: amapStyle.value,
      resizeEnable: true,
      zooms: [3, 20],
    });

    markerCtor = AMap.Marker;
    map.addControl(new AMap.Scale());
    map.addControl(
      new AMap.ToolBar({
        position: {
          right: "18px",
          bottom: "18px",
        },
      }),
    );

    syncMarkers();
  } catch (error) {
    mapError.value = error instanceof Error ? error.message : "高德地图加载失败。";
  } finally {
    isLoading.value = false;
  }
}

onMounted(() => {
  void initializeMap();
});

onBeforeUnmount(() => {
  destroyMarkers();
  map?.destroy();
  map = null;
  markerCtor = null;
});

watch(
  () => [gpsDevices.value, props.selectedDeviceId],
  () => {
    syncMarkers();
  },
  { deep: true },
);
</script>

<template>
  <div class="gps-map-shell">
    <div v-if="!hasConfig || mapError" class="gps-placeholder">
      <div class="gps-placeholder-badge">GPS</div>
      <strong>{{ mapError ? "高德地图加载失败" : "等待 GPS 地图接入" }}</strong>
      <span>{{ mapError || emptyStateMessage }}</span>
    </div>

    <template v-else>
      <div ref="mapRoot" class="amap-root" aria-label="GPS 设备位置分布地图"></div>

      <div v-if="isLoading" class="gps-map-overlay">
        <div class="gps-overlay-card">
          <strong>正在加载高德地图</strong>
          <span>地图底图和设备点位初始化中，请稍候。</span>
        </div>
      </div>

      <div v-else-if="!gpsDevices.length" class="gps-map-overlay">
        <div class="gps-overlay-card">
          <strong>暂无设备 GPS 数据</strong>
          <span>{{ emptyStateMessage }}</span>
        </div>
      </div>
    </template>
  </div>
</template>
