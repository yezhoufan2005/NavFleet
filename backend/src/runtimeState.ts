/**
 * Process-level observability counters, shared (by reference) between the MQTT
 * client (writer), the readiness probe and the /metrics endpoint (readers).
 */
export interface RuntimeState {
  startedAt: number;
  mqttConnected: boolean;
  mqttMessagesTotal: number;
  /** Messages dropped by the ingest validation gate (never reached the store). */
  mqttMessagesRejected: number;
  storeReady: boolean;
}

export const createRuntimeState = (): RuntimeState => ({
  startedAt: Date.now(),
  mqttConnected: false,
  mqttMessagesTotal: 0,
  mqttMessagesRejected: 0,
  storeReady: false,
});
