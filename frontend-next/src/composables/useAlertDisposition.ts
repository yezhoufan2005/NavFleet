import { fleetApi, ApiError } from "@navfleet/fleet-core";
import { useFleetStore } from "@/stores/fleet";
import { useAuth } from "@/composables/useAuth";
import { notify } from "@/composables/useNotifications";
import {
  ALERT_DISPOSITION_LABELS,
  type AlertDisposition,
  type AlertDispositionPayload,
} from "@navfleet/shared";

/**
 * Message disposition actions (认领 / 释放 / 忽略 / 取消忽略) — the operator's handling of a
 * message, server-backed and orthogonal to the signal lifecycle. The *state* is read from the
 * fleet store's disposition overlay (seeded from the backend, kept live by `alert.disposition`
 * WS events); this layer is the thin action surface over the four `POST /api/alerts/*` routes.
 *
 * Writes are optimistic: the overlay updates immediately, the authoritative payload the route
 * returns (and the WS broadcast that follows) confirms it, and a failure rolls back. A 409 is a
 * concurrency conflict — another operator moved first — so the overlay is reconciled to the
 * backend's `current` holder and the operator is told who now has it, rather than a bare retry.
 *
 * Every action is the `alerts:ack` capability (operator+); the view hides the buttons from
 * viewers, and the backend enforces it regardless.
 */
export interface AlertRef {
  deviceId: string;
  id: string;
}

/** A disposition snapshot as the overlay stores it (what `applyDisposition` takes). */
interface DispositionSnapshot {
  claimedBy: string | null;
  claimedAt: string | null;
  ignoredBy: string | null;
  ignoredAt: string | null;
  version: number;
}

export const useAlertDisposition = () => {
  const fleet = useFleetStore();
  const auth = useAuth();

  const key = (deviceId: string, id: string): string => `${deviceId}:${id}`;
  const dispositionOf = (deviceId: string, id: string): AlertDisposition =>
    fleet.getDisposition(deviceId, id);

  /** Who holds the message now (claimant, else ignorer), for display next to the row. */
  const handledBy = (deviceId: string, id: string): string | null => {
    const entry = fleet.getDispositionEntry(deviceId, id);
    return entry?.claimedBy ?? entry?.ignoredBy ?? null;
  };

  /** The claimant may release their own claim; an admin may force it. */
  const canRelease = (deviceId: string, id: string): boolean => {
    const entry = fleet.getDispositionEntry(deviceId, id);
    if (!entry?.claimedBy) return false;
    return (
      auth.state.user?.role === "admin" ||
      entry.claimedBy === auth.state.user?.username
    );
  };

  const snapshotOf = (
    deviceId: string,
    id: string,
  ): DispositionSnapshot | null => {
    const entry = fleet.getDispositionEntry(deviceId, id);
    return entry
      ? {
          claimedBy: entry.claimedBy,
          claimedAt: entry.claimedAt,
          ignoredBy: entry.ignoredBy,
          ignoredAt: entry.ignoredAt,
          version: entry.version,
        }
      : null;
  };

  const empty = (): DispositionSnapshot => ({
    claimedBy: null,
    claimedAt: null,
    ignoredBy: null,
    ignoredAt: null,
    version: 0,
  });

  const applyPayload = (
    deviceId: string,
    id: string,
    payload: AlertDispositionPayload,
  ): void => {
    fleet.applyDisposition(key(deviceId, id), {
      claimedBy: payload.claimedBy,
      claimedAt: payload.claimedAt,
      ignoredBy: payload.ignoredBy,
      ignoredAt: payload.ignoredAt,
      version: payload.version,
    });
  };

  /** Roll the overlay back to a pre-write snapshot (or to unhandled when there was none). */
  const rollback = (
    deviceId: string,
    id: string,
    prev: DispositionSnapshot | null,
  ): void => {
    fleet.applyDisposition(key(deviceId, id), prev ?? empty());
  };

  /** Map a write failure to a toast; a 409 reconciles the overlay to the backend's holder. */
  const reportFailure = (
    deviceId: string,
    id: string,
    error: unknown,
    fallback: string,
  ): void => {
    if (error instanceof ApiError && error.status === 409) {
      const current =
        (error.data as { current?: AlertDispositionPayload } | null)?.current ??
        null;
      if (current) applyPayload(deviceId, id, current);
      const who = current?.claimedBy ?? current?.ignoredBy ?? "他人";
      const verb = current?.disposition === "ignored" ? "忽略" : "认领";
      notify(`操作冲突：该消息已被 ${who} ${verb}`, {
        type: "warning",
        dedupeKey: "alert-disposition-conflict",
      });
      return;
    }
    const code = error instanceof Error ? error.message : "";
    notify(code === "forbidden" ? "没有处理消息的权限" : fallback, {
      type: "error",
      dedupeKey: "alert-disposition-failed",
    });
  };

  /** Shared optimistic-write wrapper: apply `optimistic`, call `write`, confirm or roll back. */
  const run = async (
    deviceId: string,
    id: string,
    optimistic: DispositionSnapshot,
    write: (version: number | undefined) => Promise<AlertDispositionPayload>,
    fallback: string,
  ): Promise<boolean> => {
    if (!deviceId || !id) return false;
    const prev = snapshotOf(deviceId, id);
    fleet.applyDisposition(key(deviceId, id), optimistic);
    try {
      applyPayload(deviceId, id, await write(prev?.version));
      return true;
    } catch (error) {
      rollback(deviceId, id, prev);
      reportFailure(deviceId, id, error, fallback);
      return false;
    }
  };

  const claim = (deviceId: string, id: string): Promise<boolean> => {
    const prev = snapshotOf(deviceId, id);
    return run(
      deviceId,
      id,
      {
        ...empty(),
        ...prev,
        claimedBy: auth.state.user?.username ?? "",
        claimedAt: new Date().toISOString(),
      },
      (version) => fleetApi.claimAlert(deviceId, id, version),
      "认领失败，请稍后重试",
    );
  };

  const release = (deviceId: string, id: string): Promise<boolean> => {
    const prev = snapshotOf(deviceId, id);
    return run(
      deviceId,
      id,
      { ...empty(), ...prev, claimedBy: null, claimedAt: null },
      (version) => fleetApi.releaseAlert(deviceId, id, version),
      "释放失败，请稍后重试",
    );
  };

  const ignore = (
    deviceId: string,
    id: string,
    reason?: string,
  ): Promise<boolean> => {
    const prev = snapshotOf(deviceId, id);
    return run(
      deviceId,
      id,
      {
        ...empty(),
        ...prev,
        ignoredBy: auth.state.user?.username ?? "",
        ignoredAt: new Date().toISOString(),
      },
      (version) => fleetApi.ignoreAlert(deviceId, id, reason, version),
      "忽略失败，请稍后重试",
    );
  };

  const unignore = (deviceId: string, id: string): Promise<boolean> => {
    const prev = snapshotOf(deviceId, id);
    return run(
      deviceId,
      id,
      { ...empty(), ...prev, ignoredBy: null, ignoredAt: null },
      (version) => fleetApi.unignoreAlert(deviceId, id, version),
      "取消忽略失败，请稍后重试",
    );
  };

  return {
    dispositionOf,
    handledBy,
    canRelease,
    dispositionLabel: (d: AlertDisposition): string =>
      ALERT_DISPOSITION_LABELS[d],
    claim,
    release,
    ignore,
    unignore,
  };
};
