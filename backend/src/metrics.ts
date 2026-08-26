import type { Persistence } from "./persistence";
import type { DashboardStore } from "./store";
import type { RuntimeState } from "./runtimeState";

export interface MetricsDeps {
  store: DashboardStore;
  persistence: Persistence;
  state: RuntimeState;
  wsClientCount: () => number;
}

/** Render the Prometheus text-format exposition for the current process state. */
export const renderMetrics = ({
  store,
  persistence,
  state,
  wsClientCount,
}: MetricsDeps): string => {
  const summary = store.buildSummary();
  const lines = [
    "# HELP navfleet_up 1 if the backend process is running",
    "# TYPE navfleet_up gauge",
    "navfleet_up 1",
    "# HELP navfleet_uptime_seconds Process uptime in seconds",
    "# TYPE navfleet_uptime_seconds gauge",
    `navfleet_uptime_seconds ${Math.round((Date.now() - state.startedAt) / 1000)}`,
    "# HELP navfleet_devices_total Devices known to the fleet",
    "# TYPE navfleet_devices_total gauge",
    `navfleet_devices_total ${Number(summary.deviceCount) || 0}`,
    "# HELP navfleet_devices_online Devices currently online",
    "# TYPE navfleet_devices_online gauge",
    `navfleet_devices_online ${Number(summary.onlineCount) || 0}`,
    "# HELP navfleet_alerts_active Active alerts across the fleet",
    "# TYPE navfleet_alerts_active gauge",
    `navfleet_alerts_active ${Number(summary.alertCount) || 0}`,
    "# HELP navfleet_ws_connections Open WebSocket client connections",
    "# TYPE navfleet_ws_connections gauge",
    `navfleet_ws_connections ${wsClientCount()}`,
    "# HELP navfleet_mongo_connected 1 if MongoDB is connected",
    "# TYPE navfleet_mongo_connected gauge",
    `navfleet_mongo_connected ${persistence.isMongoConnected() ? 1 : 0}`,
    "# HELP navfleet_mongo_buffer_pending Telemetry docs buffered awaiting MongoDB flush",
    "# TYPE navfleet_mongo_buffer_pending gauge",
    `navfleet_mongo_buffer_pending ${persistence.pendingTelemetryCount()}`,
    "# HELP navfleet_mqtt_connected 1 if the MQTT broker is connected",
    "# TYPE navfleet_mqtt_connected gauge",
    `navfleet_mqtt_connected ${state.mqttConnected ? 1 : 0}`,
    "# HELP navfleet_mqtt_messages_total Total MQTT messages ingested",
    "# TYPE navfleet_mqtt_messages_total counter",
    `navfleet_mqtt_messages_total ${state.mqttMessagesTotal}`,
    "# HELP navfleet_mqtt_messages_rejected_total Total MQTT messages dropped by ingest validation",
    "# TYPE navfleet_mqtt_messages_rejected_total counter",
    `navfleet_mqtt_messages_rejected_total ${state.mqttMessagesRejected}`,
  ];
  return `${lines.join("\n")}\n`;
};
