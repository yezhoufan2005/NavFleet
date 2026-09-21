/**
 * Validators for the operator-editable fleet config files — `vehicles.json` and
 * `formations.json` — used when the admin **device-onboarding wizard** writes them
 * through the API (Phase 18). They mirror `parseCodebook`: hand-rolled, throwing a
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

const optionalString = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
};

const optionalBoolean = (
  value: unknown,
  label: string,
): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
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
    const deviceId = nonEmptyString(
      entry.deviceId,
      `vehicles[${index}].deviceId`,
    );
    if (seen.has(deviceId)) {
      throw new Error(`vehicles has a duplicate deviceId: ${deviceId}`);
    }
    seen.add(deviceId);
    const deviceName =
      optionalString(entry.deviceName, `vehicles[${index}].deviceName`) ??
      deviceId;
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
          : stringArray(entry.tags, `vehicles[${index}].tags`),
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
    const formationId = nonEmptyString(
      entry.formationId,
      `formations[${index}].formationId`,
    );
    if (seen.has(formationId)) {
      throw new Error(`formations has a duplicate formationId: ${formationId}`);
    }
    seen.add(formationId);
    const deviceIds = stringArray(
      entry.deviceIds,
      `formations[${index}].deviceIds`,
    );
    if (deviceIds.length === 0) {
      throw new Error(`formations[${index}].deviceIds must not be empty`);
    }
    return {
      formationId,
      formationName:
        optionalString(
          entry.formationName,
          `formations[${index}].formationName`,
        ) ?? formationId,
      deviceIds,
      sceneId: optionalString(entry.sceneId, `formations[${index}].sceneId`),
      description: optionalString(
        entry.description,
        `formations[${index}].description`,
      ),
      color: optionalString(entry.color, `formations[${index}].color`),
    };
  });
};
