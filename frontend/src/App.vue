<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import GpsMap from "./components/GpsMap.vue";
import RosSceneMap from "./components/RosSceneMap.vue";
import LoginForm from "./components/LoginForm.vue";
import { useDashboard } from "./composables/useDashboard";
import { useAuth } from "./composables/useAuth";
import { controlModeMap, gearMap, taskStatusMap, formatEnum, describeEnum } from "./utils/enums";

const dashboard = useDashboard();
const auth = useAuth();
const authState = auth.state;
let dashboardStarted = false;

const {
  state,
  filteredDevices,
  sortedDevices,
  sortedFormations,
  selectedDevice,
  selectedFormation,
  summary,
  groupedAlerts,
  sceneDevices,
  formationSceneId,
  hasPose,
  round,
  formatDateTime,
  getSceneDefinition,
  getDeviceTone,
  bootstrap,
  registerWindowApi,
  selectDevice,
  selectFormation,
  clearFormationSelection,
  setMapMode,
  getPlannedPath,
  setPlannedPath,
  clearPlannedPath,
  undoPlannedPathPoint,
  setPathEditMode,
  trailsByDeviceId,
  clearTrail,
} = dashboard;

const isAlertDrawerOpen = ref(false);
const alertSeverities = ["critical", "warning", "notice"];
const activeAlertSeverity = ref("critical");

const severityLabelMap = {
  critical: "严重",
  warning: "预警",
  notice: "提示",
};

const toneLabelMap = {
  normal: "正常",
  warning: "预警",
  critical: "告警",
  notice: "提示",
  offline: "离线",
};

const roleLabelMap = {
  admin: "管理员",
  operator: "操作员",
  viewer: "只读",
};

const alertSourceLabelMap = {
  info_code: "提示报码",
  warning_code: "预警报码",
  error_code: "告警报码",
};

const activeSceneId = computed(() => formationSceneId.value || selectedDevice.value?.sceneId || "");
const selectedSceneDefinition = computed(() => getSceneDefinition(activeSceneId.value));
const selectedPathPoints = computed(() => getPlannedPath(selectedDevice.value?.deviceId));
const selectedTrailLength = computed(() => {
  const deviceId = selectedDevice.value?.deviceId;
  return deviceId ? (trailsByDeviceId.value[deviceId]?.length ?? 0) : 0;
});

const duplicateNames = computed(() => {
  const nameCount = sortedDevices.value.reduce((accumulator, device) => {
    const key = device.deviceName || device.deviceId;
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});

  return new Set(
    Object.entries(nameCount)
      .filter(([, count]) => count > 1)
      .map(([name]) => name),
  );
});

const alertStats = computed(() => ({
  critical: groupedAlerts.value.critical.length,
  warning: groupedAlerts.value.warning.length,
  notice: groupedAlerts.value.notice.length,
}));

const visibleAlerts = computed(() => groupedAlerts.value[activeAlertSeverity.value] || []);

const alertButtonTone = computed(() => {
  if (alertStats.value.critical > 0) {
    return "critical";
  }
  if (alertStats.value.warning > 0) {
    return "warning";
  }
  if (alertStats.value.notice > 0) {
    return "notice";
  }
  return "normal";
});

const selectedTone = computed(() =>
  selectedDevice.value ? getDeviceTone(selectedDevice.value) : "normal",
);
const selectedToneLabel = computed(() => toneLabelMap[selectedTone.value] || "正常");
const selectedSceneLabel = computed(
  () => selectedSceneDefinition.value?.sceneName || activeSceneId.value || "未配置场景",
);
const selectedFormationLabel = computed(() => selectedFormation.value?.formationName || "全部设备");

const selectedCodeCards = computed(() => {
  if (!selectedDevice.value) {
    return [];
  }

  return [
    { key: "info", label: "提示报码", tone: "notice", payload: selectedDevice.value.infoCode },
    {
      key: "warning",
      label: "预警报码",
      tone: "warning",
      payload: selectedDevice.value.warningCode,
    },
    { key: "error", label: "告警报码", tone: "critical", payload: selectedDevice.value.errorCode },
  ];
});

const hasSelectedRosPose = computed(
  () => hasPose(selectedDevice.value?.fusionLoc) || hasPose(selectedDevice.value?.lidarLoc),
);

function formatNumber(value, digits = 2, unit = "") {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return "--";
  }
  return `${numeric.toFixed(digits)}${unit}`;
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") {
    return "--";
  }
  return String(value);
}

function formatStamp(value) {
  if (!value) {
    return "--";
  }
  return formatDateTime(value);
}

function shouldShowDeviceId(device) {
  return duplicateNames.value.has(device.deviceName || device.deviceId);
}

function getAlertButtonText() {
  if (alertStats.value.critical > 0) {
    return "存在严重告警，请及时处理";
  }
  if (summary.value.alertTotal > 0) {
    return "查看当前活动告警";
  }
  return "当前没有活动告警";
}

function toggleAlertDrawer() {
  if (!isAlertDrawerOpen.value) {
    activeAlertSeverity.value =
      alertSeverities.find((severity) => alertStats.value[severity] > 0) || "critical";
  }
  isAlertDrawerOpen.value = !isAlertDrawerOpen.value;
}

function closeAlertDrawer() {
  isAlertDrawerOpen.value = false;
}

function selectAlertSeverity(severity) {
  activeAlertSeverity.value = severity;
}

function handleKeydown(event) {
  if (event.key === "Escape") {
    closeAlertDrawer();
  }
}

function handleGpsSelect(deviceId) {
  const preserveFormation =
    selectedFormation.value && (selectedFormation.value.deviceIds || []).includes(deviceId);
  selectDevice(deviceId, { preserveFormation });
  if (state.devicesById[deviceId]?.sceneId) {
    setMapMode("scene");
  }
}

function handlePathEditMode(nextValue) {
  setPathEditMode(nextValue);
}

function handlePathUpdate(points) {
  if (!selectedDevice.value?.deviceId) {
    return;
  }
  setPlannedPath(selectedDevice.value.deviceId, points);
}

function handlePathClear() {
  if (!selectedDevice.value?.deviceId) {
    return;
  }
  clearPlannedPath(selectedDevice.value.deviceId);
}

function handlePathUndo() {
  if (!selectedDevice.value?.deviceId) {
    return;
  }
  undoPlannedPathPoint(selectedDevice.value.deviceId);
}

function handleFormationSelect(formationId) {
  selectFormation(formationId);
}

function handleDeviceSelect(deviceId) {
  selectDevice(deviceId, { preserveFormation: Boolean(selectedFormation.value) });
}

async function startDashboard() {
  if (dashboardStarted) {
    return;
  }
  dashboardStarted = true;
  registerWindowApi();
  await bootstrap();
}

async function handleLogin(credentials) {
  const ok = await auth.login(credentials.username, credentials.password);
  if (ok) {
    await startDashboard();
  }
}

async function handleLogout() {
  await auth.logout();
}

onMounted(async () => {
  window.addEventListener("keydown", handleKeydown);
  const authenticated = await auth.fetchMe();
  if (authenticated) {
    await startDashboard();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleKeydown);
});
</script>

<template>
  <div v-if="authState.status === 'unknown'" class="app-loading">
    <span>正在加载…</span>
  </div>

  <LoginForm
    v-else-if="authState.status === 'anonymous'"
    :pending="authState.pending"
    :error="authState.error"
    @submit="handleLogin"
  />

  <div v-else class="app-shell">
    <header class="panel page-header">
      <div class="page-header-top">
        <div class="brand-block">
          <span class="brand-kicker">NavFleet</span>
          <h1>多车监控平台</h1>
          <span class="brand-meta">{{ state.fleetName || "默认车队" }}</span>
        </div>

        <div class="header-actions">
          <button
            type="button"
            class="alert-center-btn"
            :data-tone="alertButtonTone"
            :class="{ active: isAlertDrawerOpen }"
            @click="toggleAlertDrawer"
          >
            <div class="alert-center-copy">
              <span class="alert-center-title">告警中心</span>
              <span class="alert-center-subtitle">{{ getAlertButtonText() }}</span>
            </div>
            <span v-if="summary.alertTotal" class="alert-center-badge">{{
              summary.alertTotal
            }}</span>
          </button>

          <div v-if="authState.user" class="session-chip">
            <div class="session-meta">
              <span class="session-user">{{ authState.user.username }}</span>
              <span class="session-role">{{ roleLabelMap[authState.user.role] }}</span>
            </div>
            <button type="button" class="session-logout" title="退出登录" @click="handleLogout">
              退出
            </button>
          </div>
        </div>
      </div>

      <div class="headline-stats">
        <article class="headline-stat">
          <span class="stat-label">在线设备</span>
          <strong>{{ summary.onlineCount }} / {{ summary.totalCount }}</strong>
        </article>
        <article class="headline-stat">
          <span class="stat-label">活动告警</span>
          <strong>{{ summary.alertTotal }}</strong>
        </article>
        <article class="headline-stat">
          <span class="stat-label">当前编队</span>
          <strong>{{ selectedFormationLabel }}</strong>
        </article>
        <article class="headline-stat">
          <span class="stat-label">当前场景</span>
          <strong>{{ selectedSceneLabel }}</strong>
        </article>
      </div>
    </header>

    <main class="dashboard-grid">
      <aside class="panel fleet-panel">
        <div class="panel-head">
          <h2>设备与编队</h2>
          <span class="count-chip">{{ filteredDevices.length }}</span>
        </div>

        <section class="formation-section">
          <div class="formation-head">
            <span class="section-kicker">编队</span>
            <button
              type="button"
              class="formation-clear-btn"
              :class="{ active: !selectedFormation }"
              @click="clearFormationSelection"
            >
              全部设备
            </button>
          </div>

          <div class="formation-list">
            <button
              v-for="formation in sortedFormations"
              :key="formation.formationId"
              type="button"
              class="formation-chip"
              :class="{ active: selectedFormation?.formationId === formation.formationId }"
              :style="formation.color ? { '--formation-color': formation.color } : {}"
              @click="handleFormationSelect(formation.formationId)"
            >
              <span class="formation-chip-name">{{ formation.formationName }}</span>
              <span class="formation-chip-meta">
                {{ formation.onlineCount }}/{{ formation.deviceCount }}
              </span>
            </button>

            <div v-if="!sortedFormations.length" class="empty-alert compact">当前没有编队配置</div>
          </div>
        </section>

        <div class="device-list">
          <button
            v-for="device in filteredDevices"
            :key="device.deviceId"
            type="button"
            class="device-item"
            :data-tone="getDeviceTone(device)"
            :class="{ selected: device.deviceId === state.selectedDeviceId }"
            @click="handleDeviceSelect(device.deviceId)"
          >
            <div class="device-row">
              <div class="device-identity">
                <h3 class="device-name">{{ device.deviceName }}</h3>
                <span v-if="shouldShowDeviceId(device)" class="device-subtitle">{{
                  device.deviceId
                }}</span>
              </div>
              <span class="device-status" :data-tone="getDeviceTone(device)">
                {{ toneLabelMap[getDeviceTone(device)] || "正常" }}
              </span>
            </div>

            <div class="device-summary">
              <div class="device-summary-item">
                <span class="device-summary-label">最近上报</span>
                <strong>{{ formatStamp(device.stamp) }}</strong>
              </div>
              <div class="device-summary-item">
                <span class="device-summary-label">电量</span>
                <strong>{{ formatNumber(device.vehicleInfo.soc, 1, "%") }}</strong>
              </div>
            </div>
          </button>

          <div v-if="!filteredDevices.length" class="empty-alert">当前筛选条件下没有设备数据</div>
        </div>
      </aside>

      <section class="panel map-panel">
        <div class="panel-head map-panel-head">
          <h2>地图视图</h2>
          <div class="map-tabs">
            <button
              type="button"
              class="tab-btn"
              :class="{ active: state.selectedMapMode === 'gps' }"
              @click="setMapMode('gps')"
            >
              GPS
            </button>
            <button
              type="button"
              class="tab-btn"
              :class="{ active: state.selectedMapMode === 'scene' }"
              @click="setMapMode('scene')"
            >
              ROS 地图
            </button>
            <button
              v-if="state.selectedMapMode === 'scene' && selectedTrailLength > 1"
              type="button"
              class="tab-btn ghost"
              title="清除当前设备的历史轨迹"
              @click="clearTrail()"
            >
              清除轨迹
            </button>
          </div>
        </div>

        <div class="map-surface">
          <GpsMap
            v-if="state.selectedMapMode === 'gps'"
            :devices="sortedDevices"
            :selected-device-id="state.selectedDeviceId"
            :get-device-tone="getDeviceTone"
            @select="handleGpsSelect"
          />

          <RosSceneMap
            v-else-if="selectedDevice && selectedSceneDefinition"
            :selected-device="selectedDevice"
            :scene-definition="selectedSceneDefinition"
            :scene-devices="sceneDevices"
            :get-device-tone="getDeviceTone"
            :round="round"
            :path-points="selectedPathPoints"
            :is-path-edit-mode="state.isPathEditMode"
            :trails="trailsByDeviceId"
            @update-path="handlePathUpdate"
            @clear-path="handlePathClear"
            @undo-path="handlePathUndo"
            @set-edit-mode="handlePathEditMode"
          />

          <div v-else class="map-empty">
            <strong>暂无 ROS 地图</strong>
            <span>当前选中设备或编队还没有可用的场景地图配置。</span>
          </div>
        </div>
      </section>

      <aside class="panel detail-panel">
        <div v-if="selectedDevice" class="detail-header">
          <div class="detail-title-wrap">
            <h2 class="detail-title">{{ selectedDevice.deviceName }}</h2>
            <span class="detail-subtitle">{{ selectedDevice.deviceId }}</span>
            <span v-if="selectedFormation" class="detail-formation-tag">
              {{ selectedFormation.formationName }}
            </span>
          </div>
          <span class="state-pill" :data-tone="selectedTone">{{ selectedToneLabel }}</span>
        </div>

        <div v-if="selectedDevice" class="detail-scroll">
          <section class="detail-section">
            <h3 class="section-title">车辆信息</h3>
            <div class="detail-data-grid compact-grid">
              <article class="info-cell">
                <span>控制模式</span>
                <strong
                  :title="describeEnum(selectedDevice.vehicleInfo.controlMode, controlModeMap)"
                  >{{ formatEnum(selectedDevice.vehicleInfo.controlMode, controlModeMap) }}</strong
                >
              </article>
              <article class="info-cell">
                <span>档位</span>
                <strong :title="describeEnum(selectedDevice.vehicleInfo.gear, gearMap)">{{
                  formatEnum(selectedDevice.vehicleInfo.gear, gearMap)
                }}</strong>
              </article>
              <article class="info-cell">
                <span>速度</span>
                <strong>{{ formatNumber(selectedDevice.vehicleInfo.speed, 2, " m/s") }}</strong>
              </article>
              <article class="info-cell">
                <span>角速度</span>
                <strong>{{ formatNumber(selectedDevice.vehicleInfo.omega, 3, " rad/s") }}</strong>
              </article>
              <article class="info-cell">
                <span>电量</span>
                <strong>{{ formatNumber(selectedDevice.vehicleInfo.soc, 1, "%") }}</strong>
              </article>
            </div>
          </section>

          <section class="detail-section">
            <h3 class="section-title">设备报码</h3>
            <div class="code-grid">
              <article
                v-for="item in selectedCodeCards"
                :key="item.key"
                class="code-card"
                :data-tone="item.tone"
              >
                <div class="code-card-head">
                  <span>{{ item.label }}</span>
                  <span class="code-badge" :data-tone="item.tone">{{
                    formatValue(item.payload.code)
                  }}</span>
                </div>
                <strong>{{ item.payload.info || "暂无内容" }}</strong>
                <small>{{ formatStamp(item.payload.stamp) }}</small>
              </article>
            </div>
          </section>

          <section class="detail-section">
            <h3 class="section-title">任务信息</h3>
            <div class="detail-data-grid">
              <article class="info-cell">
                <span>任务状态</span>
                <strong :title="describeEnum(selectedDevice.taskStatus, taskStatusMap)">{{
                  formatEnum(selectedDevice.taskStatus, taskStatusMap)
                }}</strong>
              </article>
              <article class="info-cell">
                <span>平台任务状态</span>
                <strong :title="describeEnum(selectedDevice.platformTaskStatus, taskStatusMap)">{{
                  formatEnum(selectedDevice.platformTaskStatus, taskStatusMap)
                }}</strong>
              </article>
              <article class="info-cell wide">
                <span>上报时间</span>
                <strong>{{ formatStamp(selectedDevice.stamp) }}</strong>
              </article>
            </div>
          </section>

          <section class="detail-section">
            <h3 class="section-title">ROS 位姿</h3>
            <div class="pose-grid">
              <article class="pose-card">
                <div class="pose-head">
                  <span>融合定位</span>
                  <span class="pose-status" :class="{ ready: hasPose(selectedDevice.fusionLoc) }">
                    {{ hasPose(selectedDevice.fusionLoc) ? "已定位" : "无数据" }}
                  </span>
                </div>
                <div class="pose-values">
                  <span>x：{{ formatNumber(selectedDevice.fusionLoc.x, 2) }}</span>
                  <span>y：{{ formatNumber(selectedDevice.fusionLoc.y, 2) }}</span>
                  <span>yaw：{{ formatNumber(selectedDevice.fusionLoc.yaw, 3) }}</span>
                </div>
              </article>

              <article class="pose-card">
                <div class="pose-head">
                  <span>激光定位</span>
                  <span class="pose-status" :class="{ ready: hasPose(selectedDevice.lidarLoc) }">
                    {{ hasPose(selectedDevice.lidarLoc) ? "已定位" : "无数据" }}
                  </span>
                </div>
                <div class="pose-values">
                  <span>x：{{ formatNumber(selectedDevice.lidarLoc.x, 2) }}</span>
                  <span>y：{{ formatNumber(selectedDevice.lidarLoc.y, 2) }}</span>
                  <span>yaw：{{ formatNumber(selectedDevice.lidarLoc.yaw, 3) }}</span>
                </div>
              </article>
            </div>

            <div v-if="!hasSelectedRosPose" class="empty-alert compact">
              当前设备还没有可用的 ROS 位姿数据。
            </div>
          </section>

          <section class="detail-section">
            <h3 class="section-title">限速信息</h3>
            <div class="detail-data-grid">
              <article class="info-cell">
                <span>限速值</span>
                <strong>{{ formatNumber(selectedDevice.speedLimit.limit, 2) }}</strong>
              </article>
              <article class="info-cell">
                <span>减速时长</span>
                <strong>{{ formatValue(selectedDevice.speedLimit.slowdownTime) }}</strong>
              </article>
              <article class="info-cell">
                <span>来源模块</span>
                <strong>{{ formatValue(selectedDevice.speedLimit.moduleName) }}</strong>
              </article>
              <article class="info-cell wide">
                <span>更新时间</span>
                <strong>{{ formatStamp(selectedDevice.speedLimit.stamp) }}</strong>
              </article>
            </div>
          </section>
        </div>

        <div v-else class="detail-empty">
          <strong>暂无设备详情</strong>
          <span>请先从左侧选择一台设备或一个编队。</span>
        </div>
      </aside>
    </main>

    <div class="drawer-scrim" :class="{ open: isAlertDrawerOpen }" @click="closeAlertDrawer"></div>

    <aside
      class="panel alert-drawer"
      :class="{ open: isAlertDrawerOpen }"
      :aria-hidden="(!isAlertDrawerOpen).toString()"
    >
      <div class="alert-drawer-head">
        <h2>告警中心</h2>
        <button type="button" class="secondary-btn" @click="closeAlertDrawer">关闭</button>
      </div>

      <div class="drawer-summary">
        <button
          v-for="severity in alertSeverities"
          :key="severity"
          type="button"
          class="brief-card alert-tab-card"
          :data-severity="severity"
          :class="{ active: activeAlertSeverity === severity }"
          @click="selectAlertSeverity(severity)"
        >
          <span>{{ severityLabelMap[severity] }}</span>
          <strong>{{ alertStats[severity] }}</strong>
        </button>
      </div>

      <div class="alert-list">
        <article
          v-for="alert in visibleAlerts"
          :key="alert.id"
          class="alert-item"
          :data-severity="alert.severity"
          :class="{ focused: alert.deviceId === selectedDevice?.deviceId }"
        >
          <div class="alert-item-top">
            <strong>{{ alert.title }}</strong>
            <span class="severity-chip" :data-tone="alert.severity">
              {{ severityLabelMap[alert.severity] }}
            </span>
          </div>
          <p>
            代码值：{{ alert.code }}
            <span v-if="alert.info">，说明：{{ alert.info }}</span>
          </p>
          <div class="alert-meta">
            <span>{{ alert.deviceName }}</span>
            <span>{{ alertSourceLabelMap[alert.source] || alert.source }}</span>
            <span>{{ formatStamp(alert.ts) }}</span>
          </div>
        </article>

        <div v-if="!visibleAlerts.length" class="empty-alert">当前分组没有活动告警。</div>
      </div>
    </aside>
  </div>
</template>
