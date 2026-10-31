/**
 * The one reading of a time bound in a query string, shared by request validation and the
 * persistence queries. They used to parse separately: validation took a bare number as epoch
 * milliseconds and accepted anything `Number()` reads (`1.7e12`, `2026`), while the queries took
 * a bare number below 1e12 as seconds and returned null for the rest. A seconds epoch then passed
 * the 366-day report cap as a couple of days and ran as five years, and `1.7e12` passed validation
 * only to make a history query fail with a 500.
 *
 * Accepted: an ISO-8601 datetime, or a whole-number epoch — seconds below 1e12, milliseconds from
 * there. A bare number below 1e9 (before 2001 as seconds) is refused rather than guessed at: `2026`
 * is far likelier a year than a moment in 1970.
 */
export const parseTimeParam = (value: string | undefined): number | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const epoch = Number(trimmed);
    if (epoch < 1e9) return null;
    return epoch < 1e12 ? epoch * 1000 : epoch;
  }
  // A plain number in another spelling (`1.7e12`, `-5`, `12.5`) is not a datetime either.
  if (/^[-+.\deE]+$/.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
};
