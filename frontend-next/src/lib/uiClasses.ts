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
 * - Each base width is the **measured** width the column's content needs on one line (widest cell
 *   or header, plus cell padding), rounded up to 16px — field length decides it, not a guess. Free
 *   text that truncates (names, IDs, tags, titles) gets a floor of `w-24`–`w-40` by kind; columns
 *   that wrap by design (说明、能力、值) get a reading width (`w-48`–`w-80`). Typical results:
 *   时间戳 `w-40`, 状态/计数 `w-16`–`w-20`, two `sm` buttons `w-36`.
 * - The bases sum to the table's floor (`min-w-[…]`, `w-N` = N/4 rem — the fixed columns cannot
 *   shrink below it anyway). Below it the wrapper scrolls the table sideways instead of crushing
 *   the columns; the page itself never does. A table whose content fits a 1024px screen therefore
 *   does not scroll there at all.
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

/**
 * The text-overflow standard: what a line of text does when it is longer than its box.
 *
 * The aim is layout, not truncation for its own sake — the box keeps the size the layout gave it,
 * and the content inside reads normally. Three rules:
 *
 * 1. **Layout sizes the box; content never widens it.** Widths come from the grid / the column
 *    standard above. Long text wraps or ends in … inside its box.
 * 2. **The kind of text decides how.** Text you *read* (说明、建议、提示) wraps in full. Text you
 *    *scan* (名称、字段、单元格) stays on one line (two for a card title) and ends in …. An
 *    *identifier* (编号、ID、路径) must stay whole-readable: it breaks anywhere in a card, ends in …
 *    in a table.
 * 3. **Fixed pieces do not give way.** Badges, tags, buttons, timestamps and numbers keep their
 *    size (`fixed`); only the flexible piece — the name, the body — absorbs the squeeze. In a row,
 *    put the flexible piece on a `minmax(0,1fr)` grid track or give it `min-w-0` (a flex child
 *    otherwise refuses to shrink below its content, and `truncate` never bites).
 *
 * Anything that ends in … also carries `v-overflow-title` (`directives/overflowTitle.ts`), which
 * shows the full text on hover only while it is actually cut. The 报码解读 card is the reference.
 */
export const textClasses = {
  /** Read text: wraps in full; a run with no break point (long Latin token, path) still splits. */
  body: "wrap-break-word",
  /** A name or title inside a card or dialog: two lines, then …. */
  title: "min-w-0 line-clamp-2 wrap-break-word",
  /** A field value, metadata line or list label: one line, then …. */
  field: "min-w-0 truncate",
  /** A table cell (the `<td>` itself): one line, then …. */
  cell: "truncate",
  /** An identifier shown in full where there is room (a card): breaks anywhere. */
  id: "min-w-0 font-mono break-all",
  /** Badges, tags, timestamps, numbers, buttons: never wrap, never shrink. */
  fixed: "shrink-0 whitespace-nowrap",
} as const;
