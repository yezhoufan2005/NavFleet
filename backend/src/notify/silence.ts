/**
 * Quiet-hours silence (Phase 16D-2a) — pure. Is `now` (local time) inside any of a channel's
 * silence windows? A window is `{ days?, from, to }` in `"HH:MM"` local time; `days` uses
 * 0=Sunday..6=Saturday and, when absent/empty, means every day. `to <= from` marks a window that
 * wraps past midnight (e.g. `22:00`→`06:00`).
 *
 * `days` filters by the *current* local day. That is exact for non-wrapping windows and for the
 * common "every day" quiet hours (leave `days` empty); for a day-scoped wrapping window the day
 * refers to the current day, which is a documented simplification, not a bug.
 */
import type { NotifySilenceWindow } from "@navfleet/shared";

const toMinutes = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
};

export const isWithinSilence = (now: Date, windows?: NotifySilenceWindow[]): boolean => {
  if (!windows || windows.length === 0) {
    return false;
  }
  const day = now.getDay();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  return windows.some((window) => {
    const days = window.days && window.days.length ? window.days : [0, 1, 2, 3, 4, 5, 6];
    if (!days.includes(day)) {
      return false;
    }
    const from = toMinutes(window.from);
    const to = toMinutes(window.to);
    if (from === null || to === null || from === to) {
      return false;
    }
    // Non-wrapping window: [from, to). Wrapping window (to < from): [from, 24h) ∪ [0, to).
    return from < to
      ? nowMinutes >= from && nowMinutes < to
      : nowMinutes >= from || nowMinutes < to;
  });
};
