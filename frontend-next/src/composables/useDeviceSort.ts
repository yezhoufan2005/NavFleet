import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  deviceToneRank,
  getDeviceTone,
  parseTimestampMs,
} from "@navfleet/fleet-core";
import type { DeviceSnapshot } from "@navfleet/shared";

/**
 * Sorting for the devices list: which column, which direction, and where that lives.
 *
 * ## The default is 状态, and that is a fix
 *
 * `DevicesView` carried the comment «Sorted worst-first, so the row that needs
 * attention is the one you land on» over a list that was sorted by **device id**:
 * `filteredDevices` derives from `sortedDevices`, which is `localeCompare` on the id.
 * Worst-first was a different computed (`devicesByAttention`) that only 总览 and the
 * wall display ever used. So the intent was written down, and the list did not do it.
 * Now that the column is a control, the default is the deliberate answer to «what
 * should the first screen of a monitoring list show» — the vehicles in trouble.
 *
 * ## Ascending first, every column
 *
 * Every column's first click sorts ascending, and in every case that is the question
 * someone clicked the header to ask:
 *
 * | column   | ascending means      | the question it answers   |
 * | -------- | -------------------- | ------------------------- |
 * | 状态     | worst tone first     | who needs me now          |
 * | 电量     | emptiest first       | who is about to run out    |
 * | 最近上报 | oldest first         | whose data stopped         |
 * | 设备/编号/场景 | A → Z          | find the one I know        |
 *
 * That alignment is worth stating because it is *not* the usual table convention for a
 * timestamp column (most default to newest first). Newest-first on 最近上报 sorts a
 * healthy fleet by millisecond noise: every vehicle reports on the same 1 Hz cycle, so
 * the order churns every tick and tells you nothing. Oldest-first puts the silent ones
 * on top, which is the only reason to sort by that column at all.
 *
 * ## Absent values sort last, in both directions
 *
 * A vehicle with no battery reading is not at 0%, and one whose stamp will not parse is
 * not from 1970. Either treatment would put it at one end of the list as though it were
 * an extreme — the same class of lie as `formatNumber(null) → "0.00"`, which 1.0.3 just
 * finished removing from three places. They go last whichever way the column is
 * pointing, so that reversing a sort never promotes a hole to the top.
 *
 * ## The URL holds it
 *
 * `?sort=soc&dir=desc`, so a view can be pasted to a colleague — the same reasoning
 * 告警 applies to its filters and this page already applies to its formation. Unlike
 * the formation this needs no store state: nothing derives from the sort but the rows
 * themselves, so the query string can be the single source of truth outright rather
 * than through a write-here / read-there pair. The default is omitted from the URL, so
 * `/devices` stays clean and means "the default", not "whatever it was last time".
 *
 * Deliberately *not* persisted to `localStorage` like the layout preference: a layout
 * is how someone likes to work, a sort is a question they are asking this minute.
 */
export type DeviceSortKey = "tone" | "name" | "id" | "scene" | "stamp" | "soc";
export type SortDirection = "asc" | "desc";

/** What a row must supply to be sortable. Built by the view, which owns the labels. */
export interface SortableDeviceRow {
  device: DeviceSnapshot;
  sceneLabel: string;
}

/** Not exported: `dead-exports.test.ts` requires a non-test consumer, and the only
 * consumers of these are in this file. The view learns the default by not passing one. */
const DEFAULT_SORT_KEY: DeviceSortKey = "tone";
const DEFAULT_SORT_DIRECTION: SortDirection = "asc";

const SORT_KEYS: readonly DeviceSortKey[] = [
  "tone",
  "name",
  "id",
  "scene",
  "stamp",
  "soc",
];

const collate = (left: string, right: string): number =>
  left.localeCompare(right, "zh-Hans-CN");

/**
 * Comparators return a number for a present value and `null` for an absent one, so the
 * caller can apply "absent last" once instead of every comparator remembering to.
 */
type NumericRead = (row: SortableDeviceRow) => number | null;

const NUMERIC_READS: Partial<Record<DeviceSortKey, NumericRead>> = {
  tone: (row) => deviceToneRank(getDeviceTone(row.device)),
  soc: (row) => {
    const soc = row.device.vehicleInfo?.soc;
    return typeof soc === "number" && Number.isFinite(soc) ? soc : null;
  },
  stamp: (row) => parseTimestampMs(row.device.stamp),
};

const TEXT_READS: Partial<
  Record<DeviceSortKey, (row: SortableDeviceRow) => string>
> = {
  name: (row) => row.device.deviceName || row.device.deviceId,
  id: (row) => row.device.deviceId,
  scene: (row) => row.sceneLabel,
};

/**
 * Compare two rows on one column. The device id breaks every tie, so the order is
 * total: without it, rows with equal battery would be free to swap places on every
 * ingest, which is the flicker `alertOnsetAt` exists to prevent on the alert list.
 */
const compareDeviceRows = (
  left: SortableDeviceRow,
  right: SortableDeviceRow,
  key: DeviceSortKey,
  direction: SortDirection,
): number => {
  const sign = direction === "desc" ? -1 : 1;
  const numeric = NUMERIC_READS[key];
  let primary = 0;

  if (numeric) {
    const leftValue = numeric(left);
    const rightValue = numeric(right);
    if (leftValue === null || rightValue === null) {
      // Absent last, direction-independent — see the header.
      if (leftValue === rightValue) primary = 0;
      else primary = leftValue === null ? 1 : -1;
      return primary !== 0
        ? primary
        : collate(left.device.deviceId, right.device.deviceId);
    }
    primary = sign * (leftValue - rightValue);
  } else {
    const read = TEXT_READS[key];
    primary = read ? sign * collate(read(left), read(right)) : 0;
  }

  return primary !== 0
    ? primary
    : collate(left.device.deviceId, right.device.deviceId);
};

const asKey = (raw: unknown): DeviceSortKey =>
  SORT_KEYS.includes(raw as DeviceSortKey)
    ? (raw as DeviceSortKey)
    : DEFAULT_SORT_KEY;

const asDirection = (raw: unknown): SortDirection =>
  raw === "desc" ? "desc" : DEFAULT_SORT_DIRECTION;

export const useDeviceSort = () => {
  const route = useRoute();
  const router = useRouter();

  const sortKey = computed<DeviceSortKey>(() => asKey(route.query.sort));
  const sortDirection = computed<SortDirection>(() =>
    asDirection(route.query.dir),
  );

  /**
   * Click a header: sort by it ascending, or flip the direction if it is already the
   * one being sorted by. `replace` rather than `push` — a sort is not a place you
   * navigated to, and stacking six of them would make Back a way to un-sort a table
   * one click at a time.
   */
  const toggleSort = (key: DeviceSortKey): void => {
    const nextDirection: SortDirection =
      sortKey.value === key && sortDirection.value === "asc" ? "desc" : "asc";
    const isDefault =
      key === DEFAULT_SORT_KEY && nextDirection === DEFAULT_SORT_DIRECTION;
    void router.replace({
      query: {
        ...route.query,
        sort: isDefault ? undefined : key,
        dir:
          nextDirection === DEFAULT_SORT_DIRECTION ? undefined : nextDirection,
      },
    });
  };

  /** `aria-sort` for a header cell: only the active column gets a direction. */
  const ariaSortFor = (
    key: DeviceSortKey,
  ): "ascending" | "descending" | "none" =>
    sortKey.value !== key
      ? "none"
      : sortDirection.value === "asc"
        ? "ascending"
        : "descending";

  const sortRows = <T extends SortableDeviceRow>(rows: T[]): T[] =>
    [...rows].sort((left, right) =>
      compareDeviceRows(left, right, sortKey.value, sortDirection.value),
    );

  return { sortKey, sortDirection, toggleSort, ariaSortFor, sortRows };
};
