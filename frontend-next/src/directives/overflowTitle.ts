import type { Directive } from "vue";

/**
 * `v-overflow-title` — the hover text for a line that was cut short.
 *
 * The text-overflow standard (`textClasses` in `lib/uiClasses.ts`) lets scan-type text — names,
 * field values, table cells, IDs — end in … instead of pushing its container wider. Cut text has
 * to stay readable, so this puts the element's full text in `title`, **only while it is actually
 * cut**: a short value that fits gets no tooltip, so a tooltip always means "there is more here".
 *
 * Usage: `<td v-overflow-title :class="textClasses.cell">{{ name }}</td>`. Pass a string to show
 * something other than the element's own text (`v-overflow-title="row.fullPath"`).
 *
 * "Cut" is measured, not guessed: horizontally (`truncate`, one line) or vertically
 * (`line-clamp-*`, several). A `ResizeObserver` re-checks when the column or card changes width,
 * so widening the window removes a tooltip that is no longer needed. Without `ResizeObserver`
 * (old jsdom) it checks once on mount and update.
 */
type Host = HTMLElement & {
  __overflowTitle?: {
    observer: ResizeObserver | null;
    text: string | undefined;
  };
};

const isCut = (el: HTMLElement): boolean =>
  el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;

const apply = (el: Host): void => {
  const state = el.__overflowTitle;
  const full = (state?.text ?? el.textContent ?? "").trim();
  if (full && isCut(el)) el.setAttribute("title", full);
  else el.removeAttribute("title");
};

export const vOverflowTitle: Directive<Host, string | undefined> = {
  mounted(el, binding) {
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => apply(el));
    el.__overflowTitle = { observer, text: binding.value };
    observer?.observe(el);
    apply(el);
  },
  updated(el, binding) {
    if (el.__overflowTitle) el.__overflowTitle.text = binding.value;
    apply(el);
  },
  beforeUnmount(el) {
    el.__overflowTitle?.observer?.disconnect();
    delete el.__overflowTitle;
  },
};
