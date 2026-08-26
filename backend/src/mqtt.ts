import mqtt from "mqtt";
import type { AppConfig } from "./config";
import type { DashboardStore } from "./store";
import type { buildTopicScheme } from "./topics";
import type { RuntimeState } from "./runtimeState";
import { logger } from "./logger";

type TopicScheme = ReturnType<typeof buildTopicScheme>;

const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export interface MqttDeps {
  store: DashboardStore;
  topicScheme: TopicScheme;
  config: AppConfig;
  state: RuntimeState;
}

/**
 * Connect to the MQTT broker and route incoming telemetry/status messages into
 * the store. Connection state and an ingested-message counter are mirrored into
 * the shared RuntimeState for /metrics and readiness. Returns the client.
 */
export const connectMqtt = ({ store, topicScheme, config, state }: MqttDeps): mqtt.MqttClient => {
  const client = mqtt.connect(config.mqttUrl, {
    clientId: config.mqttClientId,
    username: config.mqttUsername || undefined,
    password: config.mqttPassword || undefined,
    reconnectPeriod: 5000,
  });

  client.on("connect", () => {
    state.mqttConnected = true;
    logger.info({ url: config.mqttUrl }, "Connected to MQTT broker");
    const subscriptions = [topicScheme.telemetrySubscription, topicScheme.statusSubscription];
    client.subscribe(subscriptions, (error) => {
      if (error) {
        logger.error({ err: error, subscriptions }, "Failed to subscribe MQTT topics");
        return;
      }
      logger.info({ subscriptions }, "Subscribed to MQTT topics");
    });
  });

  client.on("message", async (topic, payloadBuffer) => {
    state.mqttMessagesTotal += 1;
    const payloadText = payloadBuffer.toString("utf8");
    try {
      if (topicScheme.isStatusTopic(topic)) {
        const deviceId = topicScheme.extractDeviceId(topic);
        if (deviceId) {
          await store.applyStatus(deviceId, safeJsonParse(payloadText));
          return;
        }
      }

      await store.applyPayload({ topic, payload: safeJsonParse(payloadText) }, "mqtt");
    } catch (error) {
      logger.error({ err: error, topic, payloadText }, "Failed to process MQTT message");
    }
  });

  client.on("error", (error) => {
    logger.warn({ err: error }, "MQTT client error");
  });

  client.on("close", () => {
    state.mqttConnected = false;
  });
  client.on("offline", () => {
    state.mqttConnected = false;
  });

  return client;
};
