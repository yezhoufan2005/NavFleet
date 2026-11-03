/**
 * Formatting for vehicle metrics whose precision must be identical everywhere a reading is shown.
 *
 * State-of-charge was the cautionary tale: the live chips rounded it to a whole percent while the
 * low-battery message kept one decimal, so a 15.5% battery read "16%" on the row and "15.5%" in
 * its own alert — the same reading, two numbers. The cure is one formatter, reachable by both the
 * rule engine (which writes the alert text and lives in this DOM-free package) and the frontends
 * (which draw the chips), so soc can never drift precision between two places again.
 */

/** SOC is shown to one decimal — the resolution the telemetry actually carries (`15.5`). */
export const SOC_PRECISION = 1;

/** Round to `precision` decimals, dropping a trailing zero so `15.0` reads `15`, not `15.0`. */
const roundTo = (value: number, precision: number): number => {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

/**
 * State-of-charge as a percentage string — one decimal, trailing zero dropped (`15.5%`, `82%`),
 * `--` when there is no reading. The one spelling of soc: every chip and the low-battery message
 * route through it, so one vehicle never reads two different numbers on two surfaces.
 */
export const formatSoc = (soc: unknown): string => {
  if (soc === null || soc === undefined || soc === "") {
    return "--";
  }
  const numeric = Number(soc);
  return Number.isFinite(numeric)
    ? `${roundTo(numeric, SOC_PRECISION)}%`
    : "--";
};
