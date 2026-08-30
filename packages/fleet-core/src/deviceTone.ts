import type { DeviceSnapshot } from "@navfleet/shared";

/**
 * The one place that decides "how is this vehicle doing".
 *
 * It lived in three places before this: the tone *derivation* in the v1.0.0 store,
 * and the tone→label map copied verbatim into `GpsMap.vue` and `DashboardView.vue`.
 * Two frontends are about to run side by side for the whole of Phase 12–13, and the
 * quiet failure mode of that arrangement is exactly this shape of duplication — a
 * fifth tone, or a change to what counts as critical, applied in one copy and not
 * the others. Nothing errors; the two consoles simply disagree about a vehicle.
 *
 * Framework-free and DOM-free like everything else in this package, so both
 * frontends can import it rather than each keeping a copy honest.
 */
export type DeviceTone =
  "normal" | "notice" | "warning" | "critical" | "offline";

/**
 * Severity order, worst first. Exported because sorting a device list by "who needs
 * me most" is the whole point of the overview page, and every caller inventing its
 * own ordering is how two pages end up disagreeing about which vehicle is worse.
 */
export const DEVICE_TONE_SEVERITY: readonly DeviceTone[] = [
  "critical",
  "warning",
  "notice",
  "offline",
  "normal",
];

/** Chinese labels, matched verbatim by the existing Playwright suite. */
export const deviceToneLabels: Record<DeviceTone, string> = {
  normal: "正常",
  notice: "提示",
  warning: "预警",
  critical: "告警",
  offline: "离线",
};

/**
 * Is a report code actually present and non-zero?
 *
 * Coerced rather than tested for truthiness, because the field arrives from MQTT as
 * either a number or a numeric string and `"0"` is truthy. The finiteness check is
 * the part that matters and is **a fix, not a port**: v1.0.0 wrote
 * `Number(device.errorCode?.code) !== 0`, and for a payload with no `errorCode` at
 * all that is `Number(undefined) !== 0` → `NaN !== 0` → **true**, so a device whose
 * codes were simply absent reported as 告警. Absent means "not reported"; it must not
 * read as the worst possible state. Found by the first test written against this
 * logic, which is roughly the point of extracting it.
 */
const hasCode = (code: unknown): boolean => {
  const value = Number(code);
  return Number.isFinite(value) && value !== 0;
};

/**
 * Offline wins over every code, and that ordering is deliberate: a vehicle we have
 * not heard from has *stale* codes, so reporting its last known error as current
 * would be worse than saying we do not know. Below that, the codes are ranked
 * error → warning → info.
 */
export const getDeviceTone = (
  device: Pick<
    DeviceSnapshot,
    "online" | "errorCode" | "warningCode" | "infoCode"
  >,
): DeviceTone => {
  if (!device.online) return "offline";
  if (hasCode(device.errorCode?.code)) return "critical";
  if (hasCode(device.warningCode?.code)) return "warning";
  if (hasCode(device.infoCode?.code)) return "notice";
  return "normal";
};

/** The label for a device, in one call — the pairing callers actually want. */
export const getDeviceToneLabel = (
  device: Parameters<typeof getDeviceTone>[0],
): string => deviceToneLabels[getDeviceTone(device)];

/** Lower is worse. `-1` for a tone this module does not know. */
export const deviceToneRank = (tone: DeviceTone): number =>
  DEVICE_TONE_SEVERITY.indexOf(tone);
