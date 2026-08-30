import { computed, readonly, ref, toValue } from "vue";
import type { MaybeRefOrGetter } from "vue";

/**
 * How the devices page is being looked at: list or map, and which map.
 *
 * Two independent preferences live here because there are two independent questions,
 * and 13A-1's note conflated them — it said the v1.0.0 `gps|scene` toggle was not
 * ported "because 13A-2 needs three states". That was wrong: the three-state one is
 * about **layout** (list vs map), and `gps|scene` is about **which map surface**.
 * Both are needed, so both are here.
 *
 * ## Layout: three stored states, two rendered ones
 *
 * | preference | what it means                              |
 * | ---------- | ------------------------------------------ |
 * | `auto`     | decide by fleet size (the default)         |
 * | `list`     | the list, whatever the fleet size          |
 * | `map`      | the map, whatever the fleet size           |
 *
 * `auto` exists because the right answer depends on how many vehicles there are: a
 * map of six is the best view of a site, and a map of two hundred is a cloud of
 * overlapping markers. The threshold is **40**, which is the one measured figure the
 * Phase 11 research produced. What decides it is the map's readability, not list
 * performance — mounting 200 rows measured at 34.5 ms, which constrains nothing.
 *
 * An explicit choice outranks the threshold permanently, so `auto` is only ever
 * consulted until someone disagrees with it once. That is the whole reason the
 * preference has three states rather than being a boolean: with two, the act of
 * looking at the list for one crowded site would silently opt you out of ever
 * getting the map back automatically.
 *
 * ## Surface: the old key on purpose
 *
 * The surface preference keeps v1.0.0's `navfleet:map-mode` key and its exact value
 * set. `localStorage` is per-origin and the two frontends run on different ports
 * today, so nothing is shared yet — but in Phase 14 the console takes over the old
 * frontend's origin, and at that point reusing the key means an operator's choice
 * survives the switchover instead of silently resetting to GPS.
 */
export type DeviceLayoutPreference = "auto" | "list" | "map";
export type DeviceLayout = "list" | "map";
export type MapSurface = "gps" | "scene";

const LAYOUT_STORAGE_KEY = "navfleet:device-layout";
const SURFACE_STORAGE_KEY = "navfleet:map-mode";

/** See the header: the one measured number Phase 11 produced. */
export const MAP_READABLE_LIMIT = 40;

const LAYOUT_VALUES: readonly DeviceLayoutPreference[] = [
  "auto",
  "list",
  "map",
];
const SURFACE_VALUES: readonly MapSurface[] = ["gps", "scene"];

const readStored = <T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T => {
  try {
    const stored = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(stored ?? "")
      ? (stored as T)
      : fallback;
  } catch {
    // Private mode can throw on access alone.
    return fallback;
  }
};

const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage blocked; the choice still holds for this tab.
  }
};

/** Module singletons: one devices page per tab, and its state must not fork. */
const layoutPreference = ref<DeviceLayoutPreference>(
  readStored(LAYOUT_STORAGE_KEY, LAYOUT_VALUES, "auto"),
);
const surface = ref<MapSurface>(
  readStored(SURFACE_STORAGE_KEY, SURFACE_VALUES, "gps"),
);

export const useDeviceView = (deviceCount: MaybeRefOrGetter<number>) => {
  // `toValue` so a caller can pass the store's computed directly, or a getter over
  // it. A getter has to read reactive state to stay live — one over a plain local
  // variable is read exactly once, which is a Vue rule rather than a choice here.
  const count = computed(() => toValue(deviceCount));

  const layout = computed<DeviceLayout>(() => {
    if (layoutPreference.value !== "auto") return layoutPreference.value;
    return count.value > MAP_READABLE_LIMIT ? "list" : "map";
  });

  /** True while nobody has overridden the threshold — for labelling the control. */
  const layoutIsAutomatic = computed(() => layoutPreference.value === "auto");

  const setLayout = (next: DeviceLayoutPreference): void => {
    layoutPreference.value = next;
    write(LAYOUT_STORAGE_KEY, next);
  };

  const setSurface = (next: MapSurface): void => {
    surface.value = next;
    write(SURFACE_STORAGE_KEY, next);
  };

  return {
    layout,
    layoutIsAutomatic,
    layoutPreference: readonly(layoutPreference),
    setLayout,
    surface: readonly(surface),
    setSurface,
  };
};

export const DEVICE_LAYOUT_STORAGE_KEY = LAYOUT_STORAGE_KEY;
export const MAP_SURFACE_STORAGE_KEY = SURFACE_STORAGE_KEY;

/** Test-only: module state would otherwise leak between files. */
export const __resetDeviceView = (): void => {
  layoutPreference.value = readStored(
    LAYOUT_STORAGE_KEY,
    LAYOUT_VALUES,
    "auto",
  );
  surface.value = readStored(SURFACE_STORAGE_KEY, SURFACE_VALUES, "gps");
};
