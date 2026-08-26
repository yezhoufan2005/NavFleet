/**
 * Process-level observability counters, shared (by reference) between the MQTT
 * client (writer), the readiness probe and the /metrics endpoint (readers).
 */
export interface RuntimeState {
  startedAt: number;
  mqttConnected: boolean;
  mqttMessagesTotal: number;
  storeReady: boolean;
}

export const createRuntimeState = (): RuntimeState => ({
  startedAt: Date.now(),
  mqttConnected: false,
  mqttMessagesTotal: 0,
  storeReady: false,
});
