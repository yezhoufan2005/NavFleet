/**
 * One table dialect, shared.
 *
 * The console had grown three: 审计/用户/外发/个人 used `rounded-sm` + a
 * `bg-surface-sunken` uppercase head + `border-t` rows; 设备 used `rounded-md` +
 * `bg-surface-raised` + a mono no-background head + `border-b` rows + tabular
 * numerals; 报码字典 used `text-xs font-medium` heads. Same widget, three looks.
 *
 * These constants are that widget once. The chosen shell is 设备's (a raised,
 * rounded, clipped panel) with 审计's head (a sunken, uppercase, muted strip) and
 * `border-b` row rules. A view still owns its own structure — 设备's sortable
 * header buttons, 审计's scroll-region role — and borrows only these surface
 * classes, so the tables finally read as one component.
 *
 * `overflow` is deliberately not baked into `wrapper`: a table that fits uses
 * `overflow-hidden` to clip its corners, one that scrolls sideways uses
 * `overflow-x-auto`, and 审计's keyboard-scrollable region uses `overflow-auto`.
 * The caller appends the one that fits.
 */
export const tableClasses = {
  /** The panel around the table. Append an `overflow-*` that fits the table. */
  wrapper: "rounded-md border border-border bg-surface-raised",
  /** Non-numeric table; add `tabular-nums` (or use `tableNumeric`) for number columns. */
  table: "w-full border-collapse text-left text-sm",
  tableNumeric: "w-full border-collapse text-left text-sm tabular-nums",
  /** The header strip. */
  thead: "bg-surface-sunken text-2xs text-ink-muted uppercase",
  /** A body row; `last:border-0` drops the trailing rule so it never doubles the wrapper. */
  row: "border-b border-border last:border-0",
} as const;
