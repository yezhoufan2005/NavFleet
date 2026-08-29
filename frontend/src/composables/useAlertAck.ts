/**
 * Client-side alert acknowledgement.
 *
 * Alerts are derived from live telemetry (see `@navfleet/fleet-core`) and are
 * therefore read-only — there is no backend mutation to "clear" one. Operators
 * still need to mute an alert they have seen, so acknowledgement is tracked
 * locally, keyed by the alert's stable id, and persisted to localStorage so it
 * survives reloads. When the underlying condition clears the alert simply
 * disappears; a recurring alert keeps its acknowledgement until the operator
 * un-acknowledges or clears it.
 */

import { reactive } from "vue";

const STORAGE_KEY = "navfleet:acked-alerts";

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

// Module singleton so every view shares one acknowledgement set.
const state = reactive({ ids: load() });

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.ids]));
  } catch {
    // Storage unavailable (private mode / quota) — acknowledgement stays in-memory.
  }
}

export function useAlertAck() {
  const isAcknowledged = (id: string): boolean => state.ids.has(id);

  const acknowledge = (id: string): void => {
    if (!id) {
      return;
    }
    state.ids.add(id);
    persist();
  };

  const unacknowledge = (id: string): void => {
    state.ids.delete(id);
    persist();
  };

  const acknowledgeMany = (ids: string[]): void => {
    ids.forEach((id) => id && state.ids.add(id));
    persist();
  };

  const clearAll = (): void => {
    state.ids.clear();
    persist();
  };

  return { state, isAcknowledged, acknowledge, unacknowledge, acknowledgeMany, clearAll };
}
