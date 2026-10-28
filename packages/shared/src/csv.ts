/**
 * One CSV cell, shared by the console's report export and the scheduled-report email so both write
 * the same file.
 *
 * Quoted when it holds a quote, comma or line break. And — the reason this lives in one place — a
 * text cell that a spreadsheet would read as a formula (`=`, `+`, `-`, `@`, tab, carriage return)
 * is prefixed with `'`, so a device name like `=HYPERLINK(…)` opens as text instead of executing
 * (CSV injection). Numbers are written as-is: `-3.5` is a value, not a formula.
 */
export const csvField = (value: string | number): string => {
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
