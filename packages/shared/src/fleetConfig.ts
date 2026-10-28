/**
 * Validators for the operator-editable fleet config files — `vehicles.json` and
 * `formations.json` — used when the admin **device-onboarding wizard** writes them
 * through the API. They mirror `parseCodebook`: hand-rolled, throwing a
 * labelled message on the first problem, so an invalid payload is a 400 that writes
 * nothing, and the backend stays the authority even though the client validates too.
 *
 * They deliberately do NOT check the formation→vehicle referential integrity (every
 * `deviceId` in a formation must be a configured vehicle): that spans two files, so it
 * lives at the write site (`configRegistry.writeFormations`), which knows the current
 * vehicle set. These functions validate one file's shape in isolation.
 */

import type { DeviceConfig, FormationConfig } from "./index";

const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
};

const nonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
};

/** Upper bound on free-text fields (names, notes, descriptions). */
export const CONFIG_TEXT_MAX = 200;
/** Longest device id the ingest path admits (`DEVICE_ID_MAX_LENGTH` in the backend). */
export const DEVICE_ID_MAX = 200;
/**
 * Characters a device id cannot contain: it is a topic segment on the broker, so whitespace and
 * the MQTT wildcards/separators (`/ + #`) or control characters could never match a report — a
 * vehicle configured with one would sit in the list forever without data. Same rule as ingest.
 */
// eslint-disable-next-line no-control-regex -- rejecting control characters is the point
const FORBIDDEN_DEVICE_ID_CHARS = /[\s/+#\u0000-\u001f\u007f]/;

/** An id: trimmed, non-empty, bounded, and (optionally) free of characters that break a topic. */
const requireId = (
  value: unknown,
  label: string,
  max: number,
  topicSafe = false,
): string => {
  const id = nonEmptyString(value, label).trim();
  if (id.length > max)
    throw new Error(`${label} must be at most ${max} characters`);
  if (topicSafe && FORBIDDEN_DEVICE_ID_CHARS.test(id)) {
    throw new Error(
      `${label} must not contain spaces, / + # or control characters`,
    );
  }
  return id;
};

/** A bounded optional text field. */
const boundedText = (value: unknown, label: string): string | undefined => {
  const text = optionalString(value, label);
  if (text !== undefined && text.length > CONFIG_TEXT_MAX) {
    throw new Error(`${label} must be at most ${CONFIG_TEXT_MAX} characters`);
  }
  return text;
};

const optionalString = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  // Whitespace-only is empty, matching `nonEmptyString`: otherwise a "   " name survived
  // instead of defaulting to the id, leaving a blank-looking label.
  return value.trim() === "" ? undefined : value;
};

const optionalBoolean = (
  value: unknown,
  label: string,
): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
};

/** A non-negative finite number, or undefined when absent (e.g. a rated load in kg). */
const optionalNonNegativeNumber = (
  value: unknown,
  label: string,
): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a number ≥ 0`);
  }
  return value;
};

const stringArray = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value))
    throw new Error(`${label} must be an array of strings`);
  return value.map((item, index) => nonEmptyString(item, `${label}[${index}]`));
};

// APPEND-MARKER

/**
 * Validate `vehicles.json` content into `DeviceConfig[]`. `deviceId` is required, non-empty
 * and unique; `deviceName` defaults to the id (matching the config registry's load-time
 * behaviour); the rest are optional overrides. Vehicles are **config overrides**, not device
 * creation — a device still only appears once it reports.
 */
export const parseVehicles = (raw: unknown): DeviceConfig[] => {
  if (!Array.isArray(raw)) {
    throw new Error("vehicles must be a JSON array of entries");
  }
  const seen = new Set<string>();
  return raw.map((value, index) => {
    const entry = asObject(value, `vehicles[${index}]`);
    const deviceId = requireId(
      entry.deviceId,
      `vehicles[${index}].deviceId`,
      DEVICE_ID_MAX,
      true,
    );
    if (seen.has(deviceId)) {
      throw new Error(`vehicles has a duplicate deviceId: ${deviceId}`);
    }
    seen.add(deviceId);
    const deviceName =
      boundedText(entry.deviceName, `vehicles[${index}].deviceName`) ??
      deviceId;
    const commissionedAt = optionalString(
      entry.commissionedAt,
      `vehicles[${index}].commissionedAt`,
    );
    if (
      commissionedAt !== undefined &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(commissionedAt) ||
        Number.isNaN(Date.parse(commissionedAt)))
    ) {
      throw new Error(
        `vehicles[${index}].commissionedAt must be a date YYYY-MM-DD`,
      );
    }
    return {
      deviceId,
      deviceName,
      defaultSceneId: optionalString(
        entry.defaultSceneId,
        `vehicles[${index}].defaultSceneId`,
      ),
      gpsEnabled: optionalBoolean(
        entry.gpsEnabled,
        `vehicles[${index}].gpsEnabled`,
      ),
      rosMapEnabled: optionalBoolean(
        entry.rosMapEnabled,
        `vehicles[${index}].rosMapEnabled`,
      ),
      tags:
        entry.tags === undefined
          ? undefined
          : [
              ...new Set(
                stringArray(entry.tags, `vehicles[${index}].tags`).map((tag) =>
                  tag.trim(),
                ),
              ),
            ],
      // Identity / spec metadata (VDA 5050 factsheet-style, all optional, display-only).
      vendor: boundedText(entry.vendor, `vehicles[${index}].vendor`),
      model: boundedText(entry.model, `vehicles[${index}].model`),
      serialNumber: boundedText(
        entry.serialNumber,
        `vehicles[${index}].serialNumber`,
      ),
      category: boundedText(entry.category, `vehicles[${index}].category`),
      maxLoadKg: optionalNonNegativeNumber(
        entry.maxLoadKg,
        `vehicles[${index}].maxLoadKg`,
      ),
      commissionedAt,
      notes: boundedText(entry.notes, `vehicles[${index}].notes`),
    };
  });
};

/**
 * Validate `formations.json` content into `FormationConfig[]`. `formationId` is required,
 * non-empty and unique; `deviceIds` is a non-empty string array; `formationName` defaults to
 * the id. Referential integrity (each `deviceId` is a configured vehicle) is checked by the
 * caller against the current vehicle set — see this module's header.
 */
export const parseFormations = (raw: unknown): FormationConfig[] => {
  if (!Array.isArray(raw)) {
    throw new Error("formations must be a JSON array of entries");
  }
  const seen = new Set<string>();
  return raw.map((value, index) => {
    const entry = asObject(value, `formations[${index}]`);
    const formationId = requireId(
      entry.formationId,
      `formations[${index}].formationId`,
      100,
    );
    if (seen.has(formationId)) {
      throw new Error(`formations has a duplicate formationId: ${formationId}`);
    }
    seen.add(formationId);
    const deviceIds = [
      ...new Set(
        stringArray(entry.deviceIds, `formations[${index}].deviceIds`).map(
          (deviceId) => deviceId.trim(),
        ),
      ),
    ];
    const color = optionalString(entry.color, `formations[${index}].color`);
    if (
      color !== undefined &&
      !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)
    ) {
      throw new Error(
        `formations[${index}].color must be a hex colour like #46d7c3`,
      );
    }
    if (deviceIds.length === 0) {
      throw new Error(`formations[${index}].deviceIds must not be empty`);
    }
    return {
      formationId,
      formationName:
        boundedText(
          entry.formationName,
          `formations[${index}].formationName`,
        ) ?? formationId,
      deviceIds,
      sceneId: optionalString(entry.sceneId, `formations[${index}].sceneId`),
      description: boundedText(
        entry.description,
        `formations[${index}].description`,
      ),
      color,
    };
  });
};
