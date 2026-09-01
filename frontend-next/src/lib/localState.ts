/**
 * What this browser is keeping for NavFleet, discovered rather than declared.
 *
 * Every preference the console stores is namespaced `navfleet:`, so the inventory is
 * produced by **scanning storage for that prefix** instead of from a hand-kept list.
 * That is the whole point: this feeds a diagnostics page, and a list maintained by
 * hand is precisely the thing that goes stale — `docs/frontend-parity.md` §8.8
 * documented five keys and there are ten today, because 13D-2 added three sound
 * preferences, 13A-2b added the device layout, and 14A added the sound-armed flag.
 * A page that answers "what is this browser holding" has to be unable to drift from
 * the answer.
 *
 * Labels are best-effort. A key with no label is still listed, under its own name —
 * the unknown case is the interesting one, because it means something wrote a
 * preference nobody has documented.
 */
export const STORAGE_PREFIX = "navfleet:";

export type StorageArea = "local" | "session";

export interface StoredEntry {
  key: string;
  area: StorageArea;
  /** Human label when we know the key; the raw key when we do not. */
  label: string;
  /** The stored string, truncated — a viewport map can be kilobytes. */
  value: string;
  /** True when the value was cut, so the page can say so rather than lie. */
  truncated: boolean;
}

/** Longest value rendered in full. Past this the page shows a prefix and says so. */
export const VALUE_PREVIEW_LIMIT = 120;

/**
 * Known keys, for readability only. Missing entries are not an error — see the
 * header. Kept here rather than imported from each composable so that reading the
 * inventory cannot pull nine modules (and their side effects) into a page that only
 * wants to list strings.
 */
const LABELS: Readonly<Record<string, string>> = {
  "navfleet:theme": "主题偏好",
  "navfleet:sidebar": "侧栏宽窄",
  "navfleet:device-layout": "设备页版式（列表 / 地图）",
  "navfleet:map-mode": "地图底图（GPS / 场景）",
  "navfleet:acked-alerts": "已确认告警",
  "navfleet:alert-sound-muted": "告警声音：静音",
  "navfleet:alert-sound-volume": "告警声音：音量",
  "navfleet:alert-sound-quiet": "告警声音：免打扰",
  "navfleet:alert-sound-armed": "告警声音：已启用过（重载后自动恢复）",
  "navfleet:ros-scene-views:v2": "场景地图视图记忆",
};

const areaOf = (area: StorageArea): Storage =>
  area === "local" ? localStorage : sessionStorage;

const readArea = (area: StorageArea): StoredEntry[] => {
  const entries: StoredEntry[] = [];
  let store: Storage;
  try {
    store = areaOf(area);
  } catch {
    // Private mode can throw on access alone; an unreadable area is an empty one.
    return entries;
  }

  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
    const raw = store.getItem(key) ?? "";
    entries.push({
      key,
      area,
      label: LABELS[key] ?? key,
      value: raw.slice(0, VALUE_PREVIEW_LIMIT),
      truncated: raw.length > VALUE_PREVIEW_LIMIT,
    });
  }
  return entries;
};

/** Both areas, sorted by key so the list does not reshuffle between renders. */
export const readStoredState = (): StoredEntry[] =>
  [...readArea("local"), ...readArea("session")].sort((left, right) =>
    left.key.localeCompare(right.key),
  );

/**
 * Removes one `navfleet:` key. Reports whether anything was actually there.
 *
 * The reason this exists beside `clearStoredState`: the old settings page cleared
 * **categories**, and deliberately left theme / map mode / device layout / sound
 * preferences alone. The port replaced that with one 全清 button, which is not the same
 * capability with a nicer label — it is a strictly more destructive action offered in
 * place of a narrower one. Per-key clearing is finer than v1.0.0's categories rather than
 * a reconstruction of them, because the inventory here is *discovered*, and a category
 * list would be exactly the hand-kept thing this file's header argues against.
 *
 * Like `clearStoredState` it does not reset the composable that wrote the key — the
 * caller reloads, for the reason given below.
 */
export const clearStoredKey = (key: string, area: StorageArea): boolean => {
  try {
    if (areaOf(area).getItem(key) === null) return false;
    areaOf(area).removeItem(key);
    return true;
  } catch {
    return false;
  }
};

/**
 * Removes every `navfleet:` key from both areas and reports how many went.
 *
 * It does **not** reset the composables that wrote them. They are module singletons
 * that read storage once at import, so their in-memory values outlive the delete —
 * which is why the caller reloads. A "clear" that leaves the old preferences running
 * until the next reload is the kind of half-action that reads as broken.
 */
export const clearStoredState = (): number => {
  let removed = 0;
  for (const area of ["local", "session"] as const) {
    let store: Storage;
    try {
      store = areaOf(area);
    } catch {
      continue;
    }
    // Collected first: removing while iterating by index skips entries.
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      try {
        store.removeItem(key);
        removed += 1;
      } catch {
        // Storage blocked mid-flight; report what actually went.
      }
    }
  }
  return removed;
};
