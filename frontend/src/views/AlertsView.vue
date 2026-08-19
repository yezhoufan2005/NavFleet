<script setup>
import { computed, onMounted, ref } from "vue";
import { storeToRefs } from "pinia";
import { useFleetStore } from "../stores/fleet";
import { formatDateTime } from "../lib/fleetNormalize";

const store = useFleetStore();
const { groupedAlerts, selectedDevice } = storeToRefs(store);

const alertSeverities = ["critical", "warning", "notice"];
const activeAlertSeverity = ref("critical");

const severityLabelMap = {
  critical: "严重",
  warning: "预警",
  notice: "提示",
};

const alertSourceLabelMap = {
  info_code: "提示报码",
  warning_code: "预警报码",
  error_code: "告警报码",
};

const alertStats = computed(() => ({
  critical: groupedAlerts.value.critical.length,
  warning: groupedAlerts.value.warning.length,
  notice: groupedAlerts.value.notice.length,
}));

const totalAlerts = computed(
  () => alertStats.value.critical + alertStats.value.warning + alertStats.value.notice,
);

const visibleAlerts = computed(() => groupedAlerts.value[activeAlertSeverity.value] || []);

function selectAlertSeverity(severity) {
  activeAlertSeverity.value = severity;
}

function formatStamp(value) {
  return value ? formatDateTime(value) : "--";
}

onMounted(() => {
  activeAlertSeverity.value =
    alertSeverities.find((severity) => alertStats.value[severity] > 0) || "critical";
});
</script>

<template>
  <section class="panel alerts-view">
    <div class="panel-head">
      <h2>告警中心</h2>
      <span class="count-chip">{{ totalAlerts }}</span>
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
  </section>
</template>
