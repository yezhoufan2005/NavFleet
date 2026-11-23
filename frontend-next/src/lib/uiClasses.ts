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
 * ## Column widths (one standard for every list)
 *
 * - The table is `table-fixed` and **every** `<col>` carries a width — no width-less column. In a
 *   `w-full` fixed table the leftover space is then spread across the columns in proportion to their
 *   widths, so on a wide screen they all grow evenly. A single width-less column would instead take
 *   all of the slack while the sized ones stay at their minimum (the cramped 状态 / overlapping
 *   最近登录 seen on the user list).
 * - Base widths follow the field's length: 时间戳 `w-44`, 状态/严重度/类型 `w-20`–`w-24`, 计数 `w-16`–`w-20`,
 *   ID `w-28`–`w-36`, 名称 `w-40`–`w-48`, 操作 by button count (two `sm` buttons `w-36`). The longest
 *   field (说明、能力、标题…) gets the largest base, so it also takes the largest share of the slack.
 * - The table carries a `min-w-[…]` equal to the sum of its bases (`w-N` = N/4 rem). Below that the
 *   wrapper scrolls the table sideways instead of crushing the columns; the page itself never does.
 * - Text that must stay on one line (timestamps, badges) is `whitespace-nowrap`; free text truncates
 *   or wraps inside its own column.
 *
 * `wrapper` therefore includes `overflow-x-auto`: every list scrolls sideways the same way, and the
 * overflow also clips the rounded corners. A wrapper with no focusable content inside adds
 * `tabindex="0" role="region"` plus a name so the sideways scroll is reachable from the keyboard.
 */
export const tableClasses = {
  /** The panel around the table; scrolls the table sideways below its `min-w-[…]`. */
  wrapper: "overflow-x-auto rounded-md border border-border bg-surface-raised",
  /** Non-numeric table; add `tabular-nums` (or use `tableNumeric`) for number columns. */
  table: "w-full border-collapse text-left text-sm",
  tableNumeric: "w-full border-collapse text-left text-sm tabular-nums",
  /** The header strip. */
  thead: "bg-surface-sunken text-2xs text-ink-muted uppercase",
  /**
   * A body row; `last:border-0` drops the trailing rule so it never doubles the wrapper,
   * and a quiet hover tint gives the row an interactive feel (rows are scannable records).
   * Hover uses `surface-hover` (a translucent neutral), NOT `surface-sunken` — the head strip
   * is `surface-sunken`, so hovering a row must not repaint it to the header's colour.
   */
  row: "border-b border-border last:border-0 transition-colors duration-150 ease-standard hover:bg-surface-hover",
} as const;
