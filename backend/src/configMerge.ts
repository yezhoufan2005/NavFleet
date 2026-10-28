/**
 * Three-way merge of a config file for concurrent edits (the "无感" half of optimistic concurrency).
 *
 * When an editor saves against version B but the file on disk has moved on to T (someone else
 * saved), plain optimistic concurrency refuses the save. That is safe but heavy-handed when the two
 * people touched different entries — one added a vehicle, the other renamed another. This module
 * merges such edits **only when it can prove the result is what both meant**, and reports a
 * conflict otherwise, so the caller falls back to refusing (409) exactly as before.
 *
 * The rule for any unit (a whole value, one list entry, one record key), given base B, ours O and
 * theirs T:
 *   - O equals B          → only they changed it: take T;
 *   - T equals B          → only we changed it: take O;
 *   - O equals T          → both made the same change: take it;
 *   - otherwise           → both changed it differently: CONFLICT.
 * "Absent" is a value like any other, so delete-vs-untouched deletes, delete-vs-modify conflicts,
 * and two different adds under one id conflict. Equality is structural (key order ignored).
 *
 * What counts as a unit is per file (`MERGE_SPECS`): list files merge per entry id; object files
 * merge per top-level key. A file without a spec is a single unit — any concurrent change conflicts.
 */

export type MergeSpec =
  | { kind: "atomic" }
  | { kind: "list"; key: string }
  | { kind: "record"; fields?: Record<string, MergeSpec> };

const ATOMIC: MergeSpec = { kind: "atomic" };

/** Per config file: how to split it into independently-mergeable units. */
export const MERGE_SPECS = {
  vehicles: { kind: "list", key: "deviceId" },
  formations: { kind: "list", key: "formationId" },
  scenes: { kind: "list", key: "sceneId" },
  codebook: { kind: "list", key: "code" },
  notify: {
    kind: "record",
    fields: { channels: { kind: "list", key: "id" }, groups: { kind: "record" } },
  },
  reports: { kind: "record", fields: { schedules: { kind: "list", key: "id" } } },
  // Each rule (lowBattery / offline) is one unit: two admins retuning different rules merge,
  // both retuning the same rule conflict.
  rules: { kind: "record" },
} as const satisfies Record<string, MergeSpec>;

export type MergeResult = { ok: true; value: unknown } | { ok: false };

const CONFLICT = Symbol("conflict");
/** A merged value, or `CONFLICT` (`unknown` already includes the symbol). */
type Merged = unknown;

/** Canonical JSON (sorted keys) so equality ignores key order. `undefined` = absent. */
const canonical = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((input as Record<string, unknown>)[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(sort(value));
};

const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);

const mergeAtomic = (base: unknown, ours: unknown, theirs: unknown): Merged => {
  if (same(ours, base)) return theirs;
  if (same(theirs, base)) return ours;
  if (same(ours, theirs)) return ours;
  return CONFLICT;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const mergeList = (base: unknown, ours: unknown, theirs: unknown, key: string): Merged => {
  if (![base, ours, theirs].every((side) => side === undefined || Array.isArray(side))) {
    return mergeAtomic(base, ours, theirs);
  }
  // Ids are scalars (string / number); anything else cannot be matched safely.
  const idOf = (entry: unknown): string | undefined => {
    const id = isRecord(entry) ? entry[key] : undefined;
    return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
  };
  const index = (list: unknown): Map<string, unknown> | null => {
    const map = new Map<string, unknown>();
    for (const entry of (list as unknown[] | undefined) ?? []) {
      const id = idOf(entry);
      // An entry without an id, or a duplicate id, cannot be matched safely.
      if (id === undefined || map.has(id)) return null;
      map.set(id, entry);
    }
    return map;
  };
  const [b, o, t] = [index(base), index(ours), index(theirs)];
  if (!b || !o || !t) return mergeAtomic(base, ours, theirs);

  // Their order first (it is what is on disk), then entries only we added, in our order.
  const order = [...t.keys(), ...[...o.keys()].filter((id) => !t.has(id))];
  for (const id of b.keys()) if (!order.includes(id)) order.push(id);
  const merged: unknown[] = [];
  for (const id of order) {
    const entry = mergeAtomic(b.get(id), o.get(id), t.get(id));
    if (entry === CONFLICT) return CONFLICT;
    if (entry !== undefined) merged.push(entry);
  }
  return merged;
};

const mergeRecord = (
  base: unknown,
  ours: unknown,
  theirs: unknown,
  fields: Record<string, MergeSpec> = {},
): Merged => {
  if (![base, ours, theirs].every((side) => side === undefined || isRecord(side))) {
    return mergeAtomic(base, ours, theirs);
  }
  const [b, o, t] = [base, ours, theirs].map((side) => (side ?? {}) as Record<string, unknown>);
  const keys = [...new Set([...Object.keys(t!), ...Object.keys(o!), ...Object.keys(b!)])];
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    const value = mergeWith(fields[key] ?? ATOMIC, b![key], o![key], t![key]);
    if (value === CONFLICT) return CONFLICT;
    if (value !== undefined) merged[key] = value;
  }
  return merged;
};

const mergeWith = (spec: MergeSpec, base: unknown, ours: unknown, theirs: unknown): Merged => {
  switch (spec.kind) {
    case "list":
      return mergeList(base, ours, theirs, spec.key);
    case "record":
      return mergeRecord(base, ours, theirs, spec.fields);
    default:
      return mergeAtomic(base, ours, theirs);
  }
};

/** Merge our edit (made against `base`) with `theirs` (what is on disk now). */
export const mergeConfig = (
  spec: MergeSpec,
  base: unknown,
  ours: unknown,
  theirs: unknown,
): MergeResult => {
  const value = mergeWith(spec, base, ours, theirs);
  return value === CONFLICT ? { ok: false } : { ok: true, value };
};
