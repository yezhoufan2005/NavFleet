<script setup>
/**
 * Settings — the client-side preferences and locally stored state that the app
 * already keeps, gathered in one place.
 *
 * Deliberately narrow: NavFleet is a read-only monitoring platform, so there is
 * nothing here that changes fleet behaviour. What it does offer is (a) the theme
 * preference as a proper radio group rather than only the header's cycle button,
 * which is unusable if you cannot see the current icon, (b) a way to clear the
 * two things the app writes to browser storage, and (c) the connection
 * diagnostics an operator would otherwise have to open devtools to read.
 */
import { computed, ref } from "vue";
import { storeToRefs } from "pinia";
import { useFleetStore } from "../stores/fleet";
import { useTheme } from "../composables/useTheme";
import { useAlertAck } from "../composables/useAlertAck";
import { useSceneViewportPersistence } from "../composables/useSceneViewportPersistence";
import { useNotifications } from "../composables/useNotifications";
import { formatStamp } from "@navfleet/fleet-core";

const store = useFleetStore();
const state = store.state;
const { summary } = storeToRefs(store);
const { state: themeState, setPreference } = useTheme();
const ack = useAlertAck();
const { readSavedSceneViews, clearSavedSceneViews } = useSceneViewportPersistence();
const { notify } = useNotifications();

const themeOptions = [
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
  { value: "system", label: "跟随系统" },
];
const themeResolvedLabel = computed(() => (themeState.resolved === "dark" ? "深色" : "浅色"));

const ackedCount = computed(() => ack.state.ids.size);

// sessionStorage is not reactive, so the count is snapshotted here and refreshed
// after we ourselves clear it — the only in-app path that changes it. Read during
// setup rather than in `onMounted` so the first paint already shows the real
// number instead of flashing a zero.
const savedViewCount = ref(Object.keys(readSavedSceneViews()).length);
function refreshSavedViewCount() {
  savedViewCount.value = Object.keys(readSavedSceneViews()).length;
}

function handleClearAcked() {
  const cleared = ackedCount.value;
  ack.clearAll();
  notify(`已清除 ${cleared} 条告警确认记录`, { type: "success" });
}

function handleClearSavedViews() {
  const cleared = savedViewCount.value;
  clearSavedSceneViews();
  refreshSavedViewCount();
  notify(`已清除 ${cleared} 个场景的视图记忆`, { type: "success" });
}

const connectionRows = computed(() => [
  { label: "车队名称", value: state.fleetName || "默认车队" },
  { label: "MQTT 主题模板", value: state.topicPattern || "未配置" },
  {
    label: "后端接口",
    value: state.realtime.apiReady ? "已连接" : "不可用",
    tone: state.realtime.apiReady ? "ok" : "critical",
  },
  {
    label: "实时推送",
    value: state.realtime.wsReady ? "已连接" : "已断开，正在重连",
    tone: state.realtime.wsReady ? "ok" : "warning",
  },
  { label: "数据来源", value: state.lastSource || "未知" },
  { label: "最近更新", value: state.lastUpdateAt ? formatStamp(state.lastUpdateAt) : "暂无数据" },
  { label: "设备总数", value: `${summary.value.onlineCount} / ${summary.value.totalCount} 在线` },
]);
</script>

<template>
  <div class="settings-view">
    <section class="panel settings-panel">
      <div class="panel-head">
        <h2>设置</h2>
      </div>

      <div class="settings-groups">
        <fieldset class="settings-group">
          <legend>外观</legend>
          <p class="settings-hint">当前生效：{{ themeResolvedLabel }}</p>
          <div class="settings-radio-row">
            <label v-for="option in themeOptions" :key="option.value" class="settings-radio">
              <input
                type="radio"
                name="theme-preference"
                :value="option.value"
                :checked="themeState.preference === option.value"
                @change="setPreference(option.value)"
              />
              <span>{{ option.label }}</span>
            </label>
          </div>
        </fieldset>

        <fieldset class="settings-group">
          <legend>本地数据</legend>
          <p class="settings-hint">
            告警确认与场景视图都只保存在这台浏览器上，不会同步到服务器或其他用户。
          </p>

          <div class="settings-action-row">
            <div class="settings-action-text">
              <strong>已确认告警</strong>
              <span>{{ ackedCount }} 条记录（清除后这些告警会重新显示）</span>
            </div>
            <button
              type="button"
              class="tab-btn ghost"
              :disabled="!ackedCount"
              @click="handleClearAcked"
            >
              清除
            </button>
          </div>

          <div class="settings-action-row">
            <div class="settings-action-text">
              <strong>场景视图记忆</strong>
              <span>{{ savedViewCount }} 个场景（清除后 ROS 地图恢复为适应场景）</span>
            </div>
            <button
              type="button"
              class="tab-btn ghost"
              :disabled="!savedViewCount"
              @click="handleClearSavedViews"
            >
              清除
            </button>
          </div>
        </fieldset>

        <fieldset class="settings-group">
          <legend>连接与数据源</legend>
          <dl class="settings-facts">
            <template v-for="row in connectionRows" :key="row.label">
              <dt>{{ row.label }}</dt>
              <dd :data-tone="row.tone">{{ row.value }}</dd>
            </template>
          </dl>
        </fieldset>
      </div>
    </section>
  </div>
</template>
