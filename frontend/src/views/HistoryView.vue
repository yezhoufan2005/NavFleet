<script setup>
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import RosSceneMap from "../components/RosSceneMap.vue";
import { useFleetStore } from "../stores/fleet";
import { fleetApi } from "../services/fleetApi";
import { notify } from "../composables/useNotifications";
import { useHistoryPlayback } from "../composables/useHistoryPlayback";
import { round, hasPose, formatDateTime, pickTrailPose } from "../lib/fleetNormalize";
import { formatNumber } from "../utils/formatters";
import { taskStatusMap, formatEnum } from "../utils/enums";

const store = useFleetStore();
const { sortedDevices } = storeToRefs(store);
const { getSceneDefinition, getDeviceTone } = store;

const deviceId = ref("");
const fromInput = ref("");
const toInput = ref("");
const limit = ref(1000);

const loading = ref(false);
const loaded = ref(false);
const {
  samples,
  cursor,
  playing,
  speed,
  currentSample,
  progressLabel,
  setSamples,
  stopPlayback,
  togglePlay,
  restart,
} = useHistoryPlayback();

// Default the device picker to the first device once the fleet loads.
watch(
  sortedDevices,
  (list) => {
    if (!deviceId.value && list.length) {
      deviceId.value = list[0].deviceId;
    }
  },
  { immediate: true },
);

const deviceOptions = computed(() =>
  sortedDevices.value.map((device) => ({
    id: device.deviceId,
    label: device.deviceName || device.deviceId,
  })),
);

function measurementsOf(sample) {
  return (sample && sample.measurements) || {};
}

const activeSceneId = computed(() => {
  const measurement = measurementsOf(currentSample.value);
  return (
    measurement.sceneId ||
    measurement.runtimeSceneId ||
    store.state.devicesById[deviceId.value]?.sceneId ||
    ""
  );
});

const sceneDefinition = computed(() => getSceneDefinition(activeSceneId.value));

// A history sample rendered as the device shape RosSceneMap/getDeviceTone expect.
const playbackDevice = computed(() => {
  const sample = currentSample.value;
  if (!sample) {
    return null;
  }
  const measurement = measurementsOf(sample);
  const live = store.state.devicesById[deviceId.value] || {};
  return {
    deviceId: deviceId.value,
    deviceName: live.deviceName || deviceId.value,
    online: measurement.online ?? true,
    stamp: sample.ts,
    sceneId: activeSceneId.value,
    gps: measurement.gps || { lat: null, lng: null, heading: null },
    fusionLoc: measurement.fusionLoc || { x: null, y: null, yaw: null },
    lidarLoc: measurement.lidarLoc || { x: null, y: null, yaw: null },
    vehicleInfo: measurement.vehicleInfo || {},
    taskStatus: measurement.taskStatus ?? null,
    infoCode: measurement.infoCode || { code: 0 },
    warningCode: measurement.warningCode || { code: 0 },
    errorCode: measurement.errorCode || { code: 0 },
    speedLimit: measurement.speedLimit || {},
  };
});

const hasPlaybackPose = computed(
  () => hasPose(playbackDevice.value?.fusionLoc) || hasPose(playbackDevice.value?.lidarLoc),
);

// Trail = every pose from the start of the window up to (and including) the cursor.
const trailsForMap = computed(() => {
  const points = [];
  for (let index = 0; index <= cursor.value && index < samples.value.length; index += 1) {
    const pose = pickTrailPose({
      fusionLoc: measurementsOf(samples.value[index]).fusionLoc,
      lidarLoc: measurementsOf(samples.value[index]).lidarLoc,
    });
    if (pose) {
      points.push({ x: round(pose.x, 3), y: round(pose.y, 3) });
    }
  }
  return { [deviceId.value]: points };
});

const currentStamp = computed(() =>
  currentSample.value ? formatDateTime(currentSample.value.ts) : "--",
);

function applyPreset(hours) {
  const now = new Date();
  const past = new Date(now.getTime() - hours * 3600 * 1000);
  const toLocal = (date) => {
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
  };
  fromInput.value = toLocal(past);
  toInput.value = toLocal(now);
}

async function loadHistory() {
  if (!deviceId.value) {
    notify("请先选择设备", { type: "warning", dedupeKey: "history-no-device" });
    return;
  }
  stopPlayback();
  loading.value = true;
  try {
    const params = { limit: Number(limit.value) || 1000 };
    if (fromInput.value) {
      params.from = new Date(fromInput.value).toISOString();
    }
    if (toInput.value) {
      params.to = new Date(toInput.value).toISOString();
    }
    const response = await fleetApi.getHistory(deviceId.value, params);
    // Endpoint returns newest-first; playback needs oldest-first.
    setSamples([...(response.items || [])].reverse());
    loaded.value = true;
    if (!samples.value.length) {
      notify("该设备在所选时间范围内没有历史轨迹数据", {
        type: "info",
        dedupeKey: "history-empty",
      });
    }
  } catch {
    setSamples([]);
    loaded.value = true;
    notify("加载历史数据失败，请稍后重试", { type: "error", dedupeKey: "history-failed" });
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="history-view">
    <section class="panel history-controls">
      <div class="history-form">
        <label class="history-field">
          <span>设备</span>
          <select v-model="deviceId">
            <option v-if="!deviceOptions.length" value="">暂无设备</option>
            <option v-for="option in deviceOptions" :key="option.id" :value="option.id">
              {{ option.label }}
            </option>
          </select>
        </label>
        <label class="history-field">
          <span>起始时间</span>
          <input v-model="fromInput" type="datetime-local" />
        </label>
        <label class="history-field">
          <span>结束时间</span>
          <input v-model="toInput" type="datetime-local" />
        </label>
        <label class="history-field narrow">
          <span>最大点数</span>
          <input v-model="limit" type="number" min="1" max="5000" />
        </label>
        <button type="button" class="primary-btn" :disabled="loading" @click="loadHistory">
          {{ loading ? "加载中…" : "加载轨迹" }}
        </button>
      </div>
      <div class="history-presets">
        <span class="section-kicker">快捷范围</span>
        <button type="button" class="tab-btn ghost" @click="applyPreset(1)">最近 1 小时</button>
        <button type="button" class="tab-btn ghost" @click="applyPreset(6)">最近 6 小时</button>
        <button type="button" class="tab-btn ghost" @click="applyPreset(24)">最近 24 小时</button>
        <button
          type="button"
          class="tab-btn ghost"
          @click="
            fromInput = '';
            toInput = '';
          "
        >
          清除时间
        </button>
      </div>
    </section>

    <main class="history-stage">
      <section class="panel history-map-panel">
        <div class="panel-head">
          <h2>轨迹回放</h2>
          <span class="count-chip">{{ progressLabel }}</span>
        </div>

        <div class="map-surface">
          <RosSceneMap
            v-if="playbackDevice && sceneDefinition && hasPlaybackPose"
            :selected-device="playbackDevice"
            :scene-definition="sceneDefinition"
            :scene-devices="[]"
            :get-device-tone="getDeviceTone"
            :round="round"
            :trails="trailsForMap"
          />

          <div v-else-if="loading" class="map-empty">
            <strong>正在加载历史轨迹…</strong>
          </div>

          <div v-else-if="loaded && !samples.length" class="map-empty">
            <strong>没有历史轨迹数据</strong>
            <span>
              历史回放依赖 MongoDB 持久化的遥测数据。请确认后端已连接 MongoDB，
              且该设备在所选时间范围内有上报记录。
            </span>
          </div>

          <div v-else-if="loaded && !hasPlaybackPose" class="map-empty">
            <strong>该轨迹缺少 ROS 位姿</strong>
            <span>选中设备的历史记录中没有融合/激光定位坐标，无法在场景地图上回放。</span>
          </div>

          <div v-else class="map-empty">
            <strong>选择设备并加载轨迹</strong>
            <span>选择一台设备与时间范围，点击“加载轨迹”后即可在此回放历史运动。</span>
          </div>
        </div>

        <div class="playback-bar">
          <button type="button" class="primary-btn" :disabled="!samples.length" @click="togglePlay">
            {{ playing ? "暂停" : "播放" }}
          </button>
          <button type="button" class="tab-btn ghost" :disabled="!samples.length" @click="restart">
            重播
          </button>
          <input
            class="playback-slider"
            type="range"
            min="0"
            :max="Math.max(0, samples.length - 1)"
            :value="cursor"
            :disabled="!samples.length"
            @input="cursor = Number($event.target.value)"
          />
          <select v-model.number="speed" class="playback-speed" :disabled="!samples.length">
            <option :value="0.5">0.5×</option>
            <option :value="1">1×</option>
            <option :value="2">2×</option>
            <option :value="4">4×</option>
          </select>
        </div>
      </section>

      <aside class="panel history-detail">
        <div class="panel-head">
          <h2>采样详情</h2>
        </div>
        <div v-if="currentSample" class="detail-data-grid">
          <article class="info-cell wide">
            <span>采样时间</span>
            <strong>{{ currentStamp }}</strong>
          </article>
          <article class="info-cell">
            <span>速度</span>
            <strong>{{ formatNumber(playbackDevice.vehicleInfo.speed, 2, " m/s") }}</strong>
          </article>
          <article class="info-cell">
            <span>电量</span>
            <strong>{{ formatNumber(playbackDevice.vehicleInfo.soc, 1, "%") }}</strong>
          </article>
          <article class="info-cell">
            <span>任务状态</span>
            <strong>{{ formatEnum(playbackDevice.taskStatus, taskStatusMap) }}</strong>
          </article>
          <article class="info-cell">
            <span>融合 X</span>
            <strong>{{ formatNumber(playbackDevice.fusionLoc.x, 2) }}</strong>
          </article>
          <article class="info-cell">
            <span>融合 Y</span>
            <strong>{{ formatNumber(playbackDevice.fusionLoc.y, 2) }}</strong>
          </article>
          <article class="info-cell">
            <span>航向 yaw</span>
            <strong>{{ formatNumber(playbackDevice.fusionLoc.yaw, 3) }}</strong>
          </article>
          <article class="info-cell">
            <span>场景</span>
            <strong>{{ sceneDefinition?.sceneName || activeSceneId || "--" }}</strong>
          </article>
        </div>
        <div v-else class="detail-empty">
          <strong>暂无采样</strong>
          <span>加载轨迹后，这里会显示当前回放位置的遥测详情。</span>
        </div>
      </aside>
    </main>
  </div>
</template>
