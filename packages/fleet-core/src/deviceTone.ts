import type { DeviceAlert, DeviceSnapshot, Severity } from "@navfleet/shared";

/**
 * The one place that decides "how is this vehicle doing".
 *
 * It lived in three places before this: the tone *derivation* in the v1.0.0 store,
 * and the tone→label map copied verbatim into `GpsMap.vue` and `DashboardView.vue`.
 * Two frontends are about to run side by side during the switch-over, and the
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

const SEVERITY_TONE: Record<Severity, DeviceTone> = {
  critical: "critical",
  warning: "warning",
  notice: "notice",
};

/**
 * Offline wins over every code, and that ordering is deliberate: a vehicle we have
 * not heard from has *stale* codes, so reporting its last known error as current
 * would be worse than saying we do not know. Below that, the worst of the report
 * codes (error → warning → info) and the active messages decides.
 *
 * The messages count because not every one comes from a code: the backend's rule
 * engine raises 低电量预警 into `alerts` with every code at 0. Read from the codes
 * alone, such a vehicle was green on the list and the map and missing from the
 * overview's 待处理项, while 消息 and the badge counted its warning.
 */
export const getDeviceTone = (
  device: Pick<
    DeviceSnapshot,
    "online" | "errorCode" | "warningCode" | "infoCode"
  > & { alerts?: readonly Pick<DeviceAlert, "severity">[] },
): DeviceTone => {
  if (!device.online) return "offline";
  const tones: DeviceTone[] = (device.alerts ?? []).map(
    (alert) => SEVERITY_TONE[alert.severity] ?? "notice",
  );
  if (hasCode(device.errorCode?.code)) tones.push("critical");
  if (hasCode(device.warningCode?.code)) tones.push("warning");
  if (hasCode(device.infoCode?.code)) tones.push("notice");
  return tones.reduce<DeviceTone>(
    (worst, tone) =>
      deviceToneRank(tone) < deviceToneRank(worst) ? tone : worst,
    "normal",
  );
};

/**
 * The text of the worst report code that is actually set, error → warning → info.
 *
 * A channel's `info` outlives its code: a frame that clears a code to 0 may leave the
 * old text in place, so reading `info` without the code showed a cleared 急停 under
 * the vehicle's current 提示. The code decides, exactly as it does for the tone.
 */
export const activeCodeText = (
  device: Pick<DeviceSnapshot, "errorCode" | "warningCode" | "infoCode">,
): string => {
  for (const channel of [
    device.errorCode,
    device.warningCode,
    device.infoCode,
  ]) {
    if (hasCode(channel?.code) && channel?.info) return channel.info;
  }
  return "";
};

/** Sources of the messages the backend builds from report codes (`normalize.ts`). */
const CODE_SOURCES = new Set(["info_code", "warning_code", "error_code"]);

/**
 * The line to show for one message where there is room for one line only (大屏, a
 * device row's pill, a toast).
 *
 * A message built from a report code has a fixed, generic title — 告警报码 / 预警报码 /
 * 提示报码 — and the fault itself in `detail`, so for those the detail leads. Every
 * other message (a rule, an offline mark, a device's own alarm) carries its meaning in
 * the title.
 */
export const alertHeadline = (
  alert: Pick<DeviceAlert, "title" | "detail" | "source">,
): string =>
  CODE_SOURCES.has(alert.source) && alert.detail ? alert.detail : alert.title;

/** Lower is worse. `-1` for a tone this module does not know. */
export const deviceToneRank = (tone: DeviceTone): number =>
  DEVICE_TONE_SEVERITY.indexOf(tone);
