/**
 * Alert disposition — the **human-handling** axis of a message, orthogonal to its machine
 * **signal** lifecycle (`active` firing → cleared). The signal axis is driven by the vehicle's
 * condition and is never set by a person; this axis records only what a person did about it.
 *
 * NavFleet is read-only monitoring: the console cannot command a vehicle, so "handling" a message
 * happens off-line (someone is dispatched / investigates). What the console stores is therefore
 * just the operator's *disposition action* and the moment the signal cleared — the same split
 * PagerDuty / Opsgenie / Alertmanager draw between an incident's state and its acknowledgement.
 *
 * The disposition is **derived** from a few primitive fields ([[AlertDispositionFields]]), never
 * stored as its own column, so the state and the fields that imply it cannot drift apart. A
 * re-fire is a new occurrence that starts `unhandled` again (the persistence layer inserts a fresh
 * document); a cleared occurrence is history and takes no further disposition change.
 */

/** The three handling states, in display order. */
export const ALERT_DISPOSITIONS = [
  "unhandled",
  "investigating",
  "ignored",
] as const;
export type AlertDisposition = (typeof ALERT_DISPOSITIONS)[number];

/** Short Chinese labels for the handling states (console chips/filters). */
export const ALERT_DISPOSITION_LABELS: Record<AlertDisposition, string> = {
  unhandled: "待处理",
  investigating: "处理中",
  ignored: "已忽略",
};

/**
 * How a message was finally closed — shown in history as "how it was handled". Derived from the
 * signal having cleared crossed with the disposition it held at that moment. While a message is
 * still firing it has no close disposition (it is not closed yet).
 */
export const ALERT_CLOSE_DISPOSITIONS = [
  "resolved_after_handling",
  "auto_recovered",
  "cleared_after_ignore",
] as const;
export type AlertCloseDisposition = (typeof ALERT_CLOSE_DISPOSITIONS)[number];

/** Chinese labels for the close dispositions (message history). */
export const ALERT_CLOSE_DISPOSITION_LABELS: Record<
  AlertCloseDisposition,
  string
> = {
  resolved_after_handling: "处理后消除",
  auto_recovered: "自动恢复·无人介入",
  cleared_after_ignore: "已忽略后消除",
};

/**
 * The primitive fields that encode disposition, set independently by the claim / ignore actions.
 * All optional: absent / null means "never set". These live on both the stored alert (the
 * authority) and the snapshot `DeviceAlert` (for display); `alertDisposition` reads them.
 *
 * `version` is the optimistic-lock counter: a disposition write carries the version it read and
 * the backend rejects it (409) if the stored version has moved on, so two operators claiming the
 * same message at once cannot both win. It starts at 0 and increments on every disposition write.
 */
export interface AlertDispositionFields {
  /** Who is investigating it (认领), and when they claimed it. */
  claimedBy?: string | null;
  claimedAt?: string | null;
  /** Who ignored it (忽略), when, and an optional reason. */
  ignoredBy?: string | null;
  ignoredAt?: string | null;
  ignoreReason?: string | null;
  /** Optimistic-lock version; bumped on every disposition write. */
  version?: number;
}

/** The derived handling state. `ignored` wins over a prior claim; otherwise a claim means
 *  investigating; otherwise unhandled. */
export const alertDisposition = (
  fields: AlertDispositionFields,
): AlertDisposition => {
  if (fields.ignoredBy) return "ignored";
  if (fields.claimedBy) return "investigating";
  return "unhandled";
};

/**
 * How a message was closed, or `null` while it is still firing. Only a cleared signal is closed;
 * then the disposition it held decides the kind: ignored → cleared-after-ignore, claimed →
 * resolved-after-handling, neither → auto-recovered (the condition passed with no one involved).
 */
export const alertCloseDisposition = (
  signal: { active: boolean } & AlertDispositionFields,
): AlertCloseDisposition | null => {
  if (signal.active) return null;
  if (signal.ignoredBy) return "cleared_after_ignore";
  if (signal.claimedBy) return "resolved_after_handling";
  return "auto_recovered";
};

/** Why a disposition transition is refused, or `null` when it is allowed. */
export type DispositionTransitionError =
  | "not_active"
  | "already_claimed"
  | "already_ignored"
  | "not_investigating"
  | "not_claimant"
  | "not_ignored";

/** What a transition guard needs to know about the target message. */
export interface DispositionState extends AlertDispositionFields {
  /** The signal axis: a cleared (history) message takes no further disposition change. */
  active: boolean;
}

/**
 * Claim a message for investigation (认领). Allowed only while it is firing and currently
 * unhandled — an already-claimed or already-ignored message is refused here (a concurrent claim
 * surfaces as `already_claimed`; the optimistic-lock version catches the exact race at the store).
 */
export const canClaim = (
  state: DispositionState,
): DispositionTransitionError | null => {
  if (!state.active) return "not_active";
  if (state.ignoredBy) return "already_ignored";
  if (state.claimedBy) return "already_claimed";
  return null;
};

/**
 * Release a claim back to unhandled. Only the claimant may release their own claim; an admin may
 * force it (passed as `isAdmin`). Requires the message to be firing and currently investigating.
 */
export const canRelease = (
  state: DispositionState,
  actor: string,
  isAdmin = false,
): DispositionTransitionError | null => {
  if (!state.active) return "not_active";
  if (!state.claimedBy || state.ignoredBy) return "not_investigating";
  if (!isAdmin && state.claimedBy !== actor) return "not_claimant";
  return null;
};

/** Ignore a message (忽略) — mark it expected/noise. Allowed while firing and not already
 *  ignored; a claim does not block it (ignoring supersedes an in-progress claim). */
export const canIgnore = (
  state: DispositionState,
): DispositionTransitionError | null => {
  if (!state.active) return "not_active";
  if (state.ignoredBy) return "already_ignored";
  return null;
};

/** Cancel an ignore (取消忽略) back to unhandled. Allowed while firing and currently ignored. */
export const canUnignore = (
  state: DispositionState,
): DispositionTransitionError | null => {
  if (!state.active) return "not_active";
  if (!state.ignoredBy) return "not_ignored";
  return null;
};
