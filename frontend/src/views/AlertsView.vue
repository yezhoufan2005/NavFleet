<script setup>
import { computed, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useFleetStore } from "../stores/fleet";
import { useAlertAck } from "../composables/useAlertAck";
import { toTimestampMs } from "../lib/fleetNormalize";
import { formatStamp } from "../utils/formatters";

const store = useFleetStore();
const { groupedAlerts, selectedDevice } = storeToRefs(store);
const ack = useAlertAck();

const severityOrder = ["critical", "warning", "notice"];
const severityWeight = { critical: 0, warning: 1, notice: 2 };
const severityLabelMap = { critical: "严重", warning: "预警", notice: "提示" };
const alertSourceLabelMap = {
  info_code: "提示报码",
  warning_code: "预警报码",
  error_code: "告警报码",
  "rule-engine": "规则引擎",
};

const PAGE_SIZE = 12;

const severityFilter = ref("all");
const deviceFilter = ref("all");
const search = ref("");
const showAcked = ref(false);
const page = ref(1);

// Flatten the store's severity buckets into one list; each item already carries
// deviceId/deviceName. Sort by severity, then newest-first.
const allAlerts = computed(() => {
  const list = [];
  severityOrder.forEach((severity) => {
    (groupedAlerts.value[severity] || []).forEach((alert) => list.push(alert));
  });
  return list.sort(
    (left, right) =>
      severityWeight[left.severity] - severityWeight[right.severity] ||
      toTimestampMs(right.ts) - toTimestampMs(left.ts),
  );
});

const stats = computed(() => ({
  critical: groupedAlerts.value.critical.length,
  warning: groupedAlerts.value.warning.length,
  notice: groupedAlerts.value.notice.length,
  total: allAlerts.value.length,
}));

const acknowledgedCount = computed(
  () => allAlerts.value.filter((alert) => ack.isAcknowledged(alert.id)).length,
);

const deviceOptions = computed(() => {
  const seen = new Map();
  allAlerts.value.forEach((alert) => {
    if (alert.deviceId && !seen.has(alert.deviceId)) {
      seen.set(alert.deviceId, alert.deviceName || alert.deviceId);
    }
  });
  return [...seen.entries()].map(([id, label]) => ({ id, label }));
});

const filteredAlerts = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  return allAlerts.value.filter((alert) => {
    if (severityFilter.value !== "all" && alert.severity !== severityFilter.value) {
      return false;
    }
    if (deviceFilter.value !== "all" && alert.deviceId !== deviceFilter.value) {
      return false;
    }
    if (!showAcked.value && ack.isAcknowledged(alert.id)) {
      return false;
    }
    if (keyword) {
      const haystack =
        `${alert.title} ${alert.deviceName} ${alert.info || ""} ${alert.detail || ""}`.toLowerCase();
      if (!haystack.includes(keyword)) {
        return false;
      }
    }
    return true;
  });
});

const totalPages = computed(() => Math.max(1, Math.ceil(filteredAlerts.value.length / PAGE_SIZE)));

const pagedAlerts = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE;
  return filteredAlerts.value.slice(start, start + PAGE_SIZE);
});

// Any filter change resets to the first page; also clamp when the list shrinks.
watch([severityFilter, deviceFilter, search, showAcked], () => {
  page.value = 1;
});
watch(totalPages, (max) => {
  if (page.value > max) {
    page.value = max;
  }
});

function setSeverityFilter(value) {
  severityFilter.value = value;
}

function toggleAck(alert) {
  if (ack.isAcknowledged(alert.id)) {
    ack.unacknowledge(alert.id);
  } else {
    ack.acknowledge(alert.id);
  }
}

function acknowledgeFiltered() {
  ack.acknowledgeMany(filteredAlerts.value.map((alert) => alert.id));
}

function prevPage() {
  page.value = Math.max(1, page.value - 1);
}

function nextPage() {
  page.value = Math.min(totalPages.value, page.value + 1);
}
</script>

<template>
  <section class="panel alerts-view">
    <div class="panel-head">
      <h2>告警中心</h2>
      <span class="count-chip">{{ stats.total }}</span>
    </div>

    <div class="drawer-summary">
      <button
        type="button"
        class="brief-card alert-tab-card"
        :class="{ active: severityFilter === 'all' }"
        @click="setSeverityFilter('all')"
      >
        <span>全部</span>
        <strong>{{ stats.total }}</strong>
      </button>
      <button
        v-for="severity in severityOrder"
        :key="severity"
        type="button"
        class="brief-card alert-tab-card"
        :data-severity="severity"
        :class="{ active: severityFilter === severity }"
        @click="setSeverityFilter(severity)"
      >
        <span>{{ severityLabelMap[severity] }}</span>
        <strong>{{ stats[severity] }}</strong>
      </button>
    </div>

    <div class="alerts-toolbar">
      <label class="alerts-filter">
        <span>设备</span>
        <select v-model="deviceFilter">
          <option value="all">全部设备</option>
          <option v-for="option in deviceOptions" :key="option.id" :value="option.id">
            {{ option.label }}
          </option>
        </select>
      </label>
      <label class="alerts-filter grow">
        <span>搜索</span>
        <input v-model="search" type="search" placeholder="按标题 / 设备 / 说明筛选" />
      </label>
      <label class="alerts-toggle">
        <input v-model="showAcked" type="checkbox" />
        <span>显示已确认（{{ acknowledgedCount }}）</span>
      </label>
      <button
        type="button"
        class="tab-btn ghost"
        :disabled="!filteredAlerts.length"
        @click="acknowledgeFiltered"
      >
        确认当前筛选
      </button>
      <button
        type="button"
        class="tab-btn ghost"
        :disabled="!acknowledgedCount"
        @click="ack.clearAll()"
      >
        清除已确认
      </button>
    </div>

    <div class="alert-list">
      <article
        v-for="alert in pagedAlerts"
        :key="alert.id"
        class="alert-item"
        :data-severity="alert.severity"
        :class="{
          focused: alert.deviceId === selectedDevice?.deviceId,
          acknowledged: ack.isAcknowledged(alert.id),
        }"
      >
        <div class="alert-item-top">
          <strong>{{ alert.title }}</strong>
          <span class="severity-chip" :data-tone="alert.severity">
            {{ severityLabelMap[alert.severity] }}
          </span>
        </div>
        <p>{{ alert.detail || alert.info || "暂无详细说明" }}</p>
        <div class="alert-item-foot">
          <div class="alert-meta">
            <span>{{ alert.deviceName }}</span>
            <span>{{ alertSourceLabelMap[alert.source] || alert.source }}</span>
            <span v-if="alert.code">报码 {{ alert.code }}</span>
            <span>{{ formatStamp(alert.ts) }}</span>
          </div>
          <button type="button" class="ack-btn" @click="toggleAck(alert)">
            {{ ack.isAcknowledged(alert.id) ? "取消确认" : "确认" }}
          </button>
        </div>
      </article>

      <div v-if="!filteredAlerts.length" class="empty-alert">
        {{ stats.total ? "当前筛选条件下没有告警。" : "当前没有活动告警，系统运行正常。" }}
      </div>
    </div>

    <div v-if="totalPages > 1" class="alerts-pagination">
      <button type="button" class="tab-btn ghost" :disabled="page <= 1" @click="prevPage">
        上一页
      </button>
      <span class="page-indicator">第 {{ page }} / {{ totalPages }} 页</span>
      <button type="button" class="tab-btn ghost" :disabled="page >= totalPages" @click="nextPage">
        下一页
      </button>
    </div>
  </section>
</template>
