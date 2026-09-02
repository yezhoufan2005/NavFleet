import mqtt from "mqtt";
import type { ZodError } from "zod";
import type { AppConfig } from "./config";
import type { DashboardStore } from "./store";
import type { buildTopicScheme } from "./topics";
import type { RuntimeState } from "./runtimeState";
import { mqttStatusSchema, mqttTelemetrySchema } from "./validation";
import { logger } from "./logger";

type TopicScheme = ReturnType<typeof buildTopicScheme>;

const safeJsonParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/** Cap the logged payload so a flood of bad frames cannot swamp the log. */
const PAYLOAD_PREVIEW_LIMIT = 200;

const previewPayload = (payloadText: string): string =>
  payloadText.length > PAYLOAD_PREVIEW_LIMIT
    ? `${payloadText.slice(0, PAYLOAD_PREVIEW_LIMIT)}… (${payloadText.length} chars total)`
    : payloadText;

const summarizeIssues = (error: ZodError): string =>
  error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");

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
    const reject = (error: ZodError): void => {
      state.mqttMessagesRejected += 1;
      logger.warn(
        { topic, issues: summarizeIssues(error), payloadPreview: previewPayload(payloadText) },
        "Dropped invalid MQTT message",
      );
    };

    try {
      const payload = safeJsonParse(payloadText);

      if (topicScheme.isStatusTopic(topic)) {
        const deviceId = topicScheme.extractDeviceId(topic);
        if (deviceId) {
          const parsedStatus = mqttStatusSchema.safeParse(payload);
          if (!parsedStatus.success) {
            reject(parsedStatus.error);
            return;
          }
          await store.applyStatus(deviceId, payload);
          return;
        }
      }

      const parsedTelemetry = mqttTelemetrySchema.safeParse(payload);
      if (!parsedTelemetry.success) {
        reject(parsedTelemetry.error);
        return;
      }

      // `sheddable`: this is the only firehose in the system, and its frames are
      // level-triggered — each one carries the device's complete current state, so
      // under overload the newest is worth strictly more than an older one still
      // queued. Status frames above are edge-triggered and are never shed.
      await store.applyPayload({ topic, payload }, "mqtt", { sheddable: true });
    } catch (error) {
      logger.error(
        { err: error, topic, payloadPreview: previewPayload(payloadText) },
        "Failed to process MQTT message",
      );
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
