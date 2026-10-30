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
const DEVICE_ID_SEGMENT = "{deviceId}";

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Only `{deviceId}` captures. Any other placeholder (`{site}`) matches one segment and is
// ignored, so the id is never taken from whichever placeholder happens to come first.
const buildDeviceIdMatcher = (segments: string[]): RegExp => {
  const pattern = segments
    .map((segment) =>
      segment === DEVICE_ID_SEGMENT
        ? "([^/]+)"
        : PLACEHOLDER_SEGMENT.test(segment)
          ? "[^/]+"
          : escapeRegExp(segment),
    )
    .join("/");
  return new RegExp(`^${pattern}$`);
};

/**
 * Why a telemetry topic pattern cannot work, or null when it can. It needs exactly one
 * `{deviceId}` segment, and not as the last segment: the status topic is derived by replacing
 * the last segment with `status`, which would drop the device id.
 */
export const topicPatternProblem = (telemetryPattern: string): string | null => {
  const segments = telemetryPattern.split("/").filter((segment) => segment !== "");
  const deviceIdAt = segments.flatMap((segment, index) =>
    segment === DEVICE_ID_SEGMENT ? [index] : [],
  );
  if (deviceIdAt.length !== 1) {
    return `must contain exactly one ${DEVICE_ID_SEGMENT} segment`;
  }
  if (deviceIdAt[0] === segments.length - 1) {
    return `${DEVICE_ID_SEGMENT} cannot be the last segment (it is replaced by "status" for the status topic)`;
  }
  return null;
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
