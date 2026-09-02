/**
 * The one honest offline default: what to *call* the fleet before the backend answers.
 *
 * This file used to carry two more things, and both were **permanently empty**:
 * `sceneCatalog = {}` and `fallbackFleetPayload.devices = []`. They were written as
 * "offline demo defaults so the shell has something to render", copied verbatim into the
 * v3 console, and between the two front ends five lookups consulted them — none of which
 * ever hit, in either front end, in any release.
 *
 * So the feature they claimed to provide never existed. Worse, the empty payload was
 * *ingested*: a backend that could not be reached produced a fleet of zero vehicles,
 * which on a monitoring console is not the same statement as "we cannot reach the
 * backend" — it is a much more alarming one, and it is false.
 *
 * The decision (ROADMAP 13T-E / 1.0.3) was **delete the path, not fill it in**: offline
 * gets an explicit empty state and a retry button. Showing invented data on a monitoring
 * console is considerably more dangerous than showing nothing.
 *
 * What survives is only what carries a value: the fleet's default display name and the
 * topic pattern, both of which the shell renders before the first snapshot lands.
 */
export interface FleetLabelDefaults {
  fleetName: string;
  topicPattern: string;
}

export const fallbackFleetPayload: FleetLabelDefaults = {
  fleetName: "智能车队",
  topicPattern: "/fleet/{deviceId}/vehicle_info",
};
