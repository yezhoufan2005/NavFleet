import { fleetApi } from "@navfleet/fleet-core";
import { useFleetStore } from "@/stores/fleet";
import { useAuth } from "@/composables/useAuth";
import { notify } from "@/composables/useNotifications";

/**
 * Alert acknowledgement — server-backed since Phase 16A.
 *
 * Confirmation used to live in this composable's own `localStorage` set of bare alert ids,
 * so it did not survive a different device, a different operator, or a cleared cache, and
 * carried no who and no when. It now lives on the `alerts` collection: this layer is the thin
 * action surface over `POST /api/alerts/(un)ack`, and the *state* it reads is the fleet
 * store's `ackState` overlay (seeded from the backend, kept live by WS), so every open console
 * agrees on what is confirmed and by whom.
 *
 * Identity moved from a bare `alert.id` to `(deviceId, id)` — the eventKey the backend keys on
 * — because a code can be active on more than one vehicle at once. Callers already have both.
 *
 * Acknowledging is an operator+ capability; the button is hidden from viewers in the view, and
 * the backend enforces it regardless. Writes are optimistic (the overlay updates immediately,
 * then the authoritative `alert.acked` broadcast confirms it) and roll back on failure.
 */
export interface AlertRef {
  deviceId: string;
  id: string;
}

const STORAGE_KEY = "navfleet:acked-alerts";
export const ALERT_ACK_STORAGE_KEY = STORAGE_KEY;

/** Module-level: the one-time localStorage migration runs at most once per page load. */
let legacyMigrationDone = false;

/** Backend error code → operator-facing message. Codes come from `fleetApi.failureError`. */
const ackErrorMessage = (error: unknown): string => {
  const code = error instanceof Error ? error.message : "";
  if (code === "forbidden") return "没有确认告警的权限";
  if (code === "not_found") return "该告警已不在活跃状态，无法确认";
  return "操作失败，请稍后重试";
};

export const useAlertAck = () => {
  const fleet = useFleetStore();
  const auth = useAuth();

  const eventKey = (deviceId: string, id: string): string =>
    `${deviceId}:${id}`;

  /** Optimistic overlay entry using the current user as best-effort actor; the WS broadcast
   *  that follows carries the authoritative `ackedBy`/`ackedAt` and overwrites it. */
  const optimisticEntry = (comment: string | null) => ({
    ackedBy: auth.state.user?.username ?? "",
    ackedAt: new Date().toISOString(),
    comment,
  });

  const isAcknowledged = (deviceId: string, id: string): boolean =>
    fleet.isAlertAcked(deviceId, id);

  /** Who confirmed a still-active alert, for display next to the row. */
  const acknowledgedBy = (deviceId: string, id: string): string | null =>
    fleet.getAck(deviceId, id)?.ackedBy ?? null;

  const acknowledge = async (
    deviceId: string,
    id: string,
    comment?: string,
  ): Promise<boolean> => {
    if (!deviceId || !id || fleet.isAlertAcked(deviceId, id)) return false;
    const key = eventKey(deviceId, id);
    fleet.applyAck(key, optimisticEntry(comment ?? null));
    try {
      // Call without the third argument when there is no comment, so the request body carries
      // no empty `comment` field (and call sites without one assert a clean two-arg call).
      await (comment === undefined
        ? fleetApi.ackAlert(deviceId, id)
        : fleetApi.ackAlert(deviceId, id, comment));
      return true;
    } catch (error) {
      fleet.applyUnack(key);
      notify(ackErrorMessage(error), { type: "error" });
      return false;
    }
  };

  const unacknowledge = async (
    deviceId: string,
    id: string,
  ): Promise<boolean> => {
    if (!deviceId || !id || !fleet.isAlertAcked(deviceId, id)) return false;
    const key = eventKey(deviceId, id);
    const previous = fleet.getAck(deviceId, id);
    fleet.applyUnack(key);
    try {
      await fleetApi.unackAlert(deviceId, id);
      return true;
    } catch (error) {
      if (previous) fleet.applyAck(key, previous);
      notify(ackErrorMessage(error), { type: "error" });
      return false;
    }
  };

  /** Acknowledge a set, returning the refs that actually changed so a caller can offer undo. */
  const acknowledgeMany = async (
    refs: readonly AlertRef[],
  ): Promise<AlertRef[]> => {
    const results = await Promise.all(
      refs.map(async (ref) =>
        (await acknowledge(ref.deviceId, ref.id)) ? ref : null,
      ),
    );
    return results.filter((ref): ref is AlertRef => ref !== null);
  };

  const unacknowledgeMany = async (
    refs: readonly AlertRef[],
  ): Promise<AlertRef[]> => {
    const results = await Promise.all(
      refs.map(async (ref) =>
        (await unacknowledge(ref.deviceId, ref.id)) ? ref : null,
      ),
    );
    return results.filter((ref): ref is AlertRef => ref !== null);
  };

  /**
   * One-time migration off the old per-browser store (Phase 16A): take the bare ids this
   * browser had acknowledged, keep the ones still matching an active alert, push each to the
   * backend, then drop the localStorage key for good. Callable only where the caller is
   * operator+ (the view guards this); the backend would 403 an unprivileged migration and the
   * key would be left in place for a later privileged session to pick up.
   */
  const migrateLegacyAcks = async (
    activeRefs: readonly AlertRef[],
  ): Promise<void> => {
    if (legacyMigrationDone) return;
    legacyMigrationDone = true;

    let legacyIds: string[];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      legacyIds = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      // Private mode can throw on read alone; nothing to migrate then.
      return;
    }
    if (!legacyIds.length) {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      return;
    }

    const legacy = new Set(legacyIds);
    const targets = activeRefs.filter(
      (ref) => legacy.has(ref.id) && !fleet.isAlertAcked(ref.deviceId, ref.id),
    );
    await Promise.allSettled(
      targets.map((ref) => acknowledge(ref.deviceId, ref.id)),
    );
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  return {
    isAcknowledged,
    acknowledgedBy,
    acknowledge,
    unacknowledge,
    acknowledgeMany,
    unacknowledgeMany,
    migrateLegacyAcks,
  };
};

/** Test-only: reset the one-time migration guard so each test starts fresh. */
export const __resetAlertAck = (): void => {
  legacyMigrationDone = false;
};
