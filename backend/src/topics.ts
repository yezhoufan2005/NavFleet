/**
 * Derives MQTT subscription topics and a device-id extractor from a single
 * telemetry topic pattern (e.g. `/fleet/{deviceId}/vehicle_info`).
 *
 * `{placeholder}` segments become MQTT single-level wildcards (`+`) for
 * subscription, and a capturing regex for extracting the device id from an
 * incoming topic. The status topic is derived by swapping the trailing leaf
 * segment for `status`, matching the `/fleet/{deviceId}/status` convention.
 */

const PLACEHOLDER_SEGMENT = /^\{[^}]+\}$/;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildDeviceIdMatcher = (segments: string[]): RegExp => {
  const pattern = segments
    .map((segment) => (PLACEHOLDER_SEGMENT.test(segment) ? "([^/]+)" : escapeRegExp(segment)))
    .join("/");
  return new RegExp(`^${pattern}$`);
};

const toWildcard = (segments: string[]): string =>
  segments.map((segment) => (PLACEHOLDER_SEGMENT.test(segment) ? "+" : segment)).join("/");

export interface TopicScheme {
  /** MQTT subscription for telemetry, e.g. `/fleet/+/vehicle_info`. */
  telemetrySubscription: string;
  /** MQTT subscription for online status, e.g. `/fleet/+/status`. */
  statusSubscription: string;
  /** Extract the device id from a concrete topic, or `""` if it does not match. */
  extractDeviceId(topic: string): string;
  /** Whether a concrete topic is a status topic under this scheme. */
  isStatusTopic(topic: string): boolean;
}

export const buildTopicScheme = (telemetryPattern: string): TopicScheme => {
  const normalized = telemetryPattern.startsWith("/") ? telemetryPattern : `/${telemetryPattern}`;
  const telemetrySegments = normalized.split("/");

  const statusSegments = [...telemetrySegments];
  statusSegments[statusSegments.length - 1] = "status";

  const telemetryMatcher = buildDeviceIdMatcher(telemetrySegments);
  const statusMatcher = buildDeviceIdMatcher(statusSegments);

  return {
    telemetrySubscription: toWildcard(telemetrySegments),
    statusSubscription: toWildcard(statusSegments),
    extractDeviceId(topic: string): string {
      const match = topic.match(statusMatcher) ?? topic.match(telemetryMatcher);
      return match?.[1] ?? "";
    },
    isStatusTopic(topic: string): boolean {
      return statusMatcher.test(topic);
    },
  };
};
