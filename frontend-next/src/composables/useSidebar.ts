import { computed, readonly, ref, watch } from "vue";
import { useMinWidth } from "@/composables/useBreakpoint";

/**
 * Sidebar state, three modes (`docs/frontend-ia.md` §3.1).
 *
 * | mode        | when                   | width  |
 * | ----------- | ---------------------- | ------ |
 * | `expanded`  | ≥ lg, user's default   | 240px  |
 * | `collapsed` | ≥ lg, user collapsed   | 44px   |
 * | `overlay`   | < lg, always           | drawer |
 *
 * Why a sidebar at all, rather than top-bar navigation: on a 16:9 screen vertical
 * pixels are the scarce ones, and the map and the ECharts curves are exactly what
 * eats height. Top navigation costs 56–64px across the full width permanently; a
 * collapsed sidebar costs 44px of width.
 *
 * Below `lg` the mode is not the user's choice — a 240px rail on a 900px tablet
 * leaves too little for a map, so it becomes a drawer over the content. The
 * expanded/collapsed preference is still remembered underneath, so rotating a
 * tablet back to landscape restores what the person had chosen.
 */
export type SidebarMode = "expanded" | "collapsed" | "overlay";

const STORAGE_KEY = "navfleet:sidebar";
const STORED_VALUES = ["expanded", "collapsed"] as const;

type StoredPreference = (typeof STORED_VALUES)[number];

const readStored = (): StoredPreference => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return (STORED_VALUES as readonly string[]).includes(stored ?? "")
      ? (stored as StoredPreference)
      : "expanded";
  } catch {
    return "expanded";
  }
};

/** Module singleton: one sidebar per tab, and the drawer must not fork state. */
const preference = ref<StoredPreference>(readStored());
const drawerOpen = ref(false);

export const useSidebar = () => {
  const wide = useMinWidth("lg");

  const mode = computed<SidebarMode>(() =>
    wide.value ? preference.value : "overlay",
  );

  // Crossing the breakpoint with the drawer open would otherwise leave a modal
  // scrim over a sidebar that is now permanently visible.
  watch(wide, (isWide) => {
    if (isWide) drawerOpen.value = false;
  });

  const setPreference = (next: StoredPreference): void => {
    preference.value = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage blocked; the choice still holds for this tab.
    }
  };

  /**
   * What the collapse control does. Above `lg` it toggles the rail; below it, the
   * same control opens and closes the drawer — one button, because to the person
   * using it there is only one idea here ("show me the navigation").
   */
  const toggle = (): void => {
    if (!wide.value) {
      drawerOpen.value = !drawerOpen.value;
      return;
    }
    setPreference(preference.value === "expanded" ? "collapsed" : "expanded");
  };

  return {
    mode,
    drawerOpen,
    isDrawer: computed(() => !wide.value),
    labelled: computed(() => mode.value !== "collapsed"),
    preference: readonly(preference),
    toggle,
    setPreference,
    closeDrawer: (): void => {
      drawerOpen.value = false;
    },
  };
};

export const SIDEBAR_STORAGE_KEY = STORAGE_KEY;
