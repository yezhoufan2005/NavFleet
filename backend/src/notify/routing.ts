/**
 * Which channels a given alert goes to (Phase 16D-1) — pure, so it is trivially testable and
 * carries no I/O.
 *
 * A channel receives an alert when it is **enabled**, its **severities** list includes the
 * alert's severity, and its **scope** matches the alert's device. Scope reuses the rule
 * engine's `deviceMatchesScope` (empty/absent scope = the whole fleet), so "these channels for
 * this formation, those for everything" is expressed exactly as rule scoping is.
 *
 * Backend-only on purpose: neither frontend routes outbound notifications, so this does not
 * belong in `@navfleet/shared` even though the config *types* it reads do (see the note there).
 */
import {
  deviceMatchesScope,
  type DeviceSnapshot,
  type NotifyChannelConfig,
  type NotifyConfig,
  type Severity,
} from "@navfleet/shared";

/** The device fields scope matching needs — all `deviceMatchesScope` reads. */
export type ScopeDevice = Pick<DeviceSnapshot, "deviceId" | "formationIds" | "tags">;

export const selectChannelsForAlert = (
  config: NotifyConfig,
  alert: { severity: Severity },
  device: ScopeDevice,
): NotifyChannelConfig[] =>
  config.channels.filter(
    (channel) =>
      channel.enabled &&
      channel.severities.includes(alert.severity) &&
      deviceMatchesScope(device, channel.scope),
  );
