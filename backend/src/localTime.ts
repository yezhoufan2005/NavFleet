/**
 * Wall-clock parts of an instant in the deployment's time zone (`REPORT_TIMEZONE`). The container
 * image sets no `TZ`, so `Date#getHours()` and friends answer in UTC; anything a person schedules
 * in local time (report send times, notify quiet hours) is read through this instead.
 */

/** 一个时刻在某时区里的本地日历部件：日期串、"HH:MM"、星期（0=周日）。 */
export const localParts = (
  ms: number,
  timezone: string,
): { date: string; hm: string; weekday: number } => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  // `en-CA` gives `2026-09-19` for the date parts and a 24h hour; `hour` can come back "24" at
  // midnight in some engines, so normalise it to "00".
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hm: `${hour}:${get("minute")}`,
    weekday: weekdayMap[get("weekday")] ?? 0,
  };
};
