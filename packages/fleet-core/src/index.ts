/**
 * `@navfleet/fleet-core` — the fleet logic both frontends share.
 *
 * Everything here is framework-free and DOM-free: no Vue, no browser globals
 * beyond `fetch`. That is not an aesthetic rule, it is the property that makes
 * the package shareable — the moment something in here reaches for a component
 * lifecycle or a `document`, it stops being usable by two frontends at once.
 *
 * Why this package exists at all: the v3 plan runs a new frontend alongside the
 * v1.0.0 one for a while. The largest risk in that arrangement is not the UI
 * work, it is these ~800 lines of normalization and formatting quietly forking
 * into two copies that drift — a bug fixed in one and not the other produces no
 * error anywhere. Extracting them is the only way to make that impossible
 * rather than merely discouraged.
 *
 * Import from the barrel (`@navfleet/fleet-core`) rather than reaching into
 * `src/…`; the file layout is free to change, the barrel is the contract.
 */

export * from "./fleetNormalize";
export * from "./fleetApi";
export * from "./enums";
export * from "./deviceTone";
export * from "./pointCloud";
export * from "./reportCodes";
export * from "./gps";
export * from "./formatters";
export * from "./dataDefaults";
