import { onScopeDispose, readonly, ref, watch } from "vue";
import { useTheme } from "@/composables/useTheme";

/**
 * Resolves the chart tokens into concrete colours ECharts can use.
 *
 * The indirection exists because the two sides speak different languages. Our token
 * layer is CSS custom properties resolved by the browser per theme; ECharts takes
 * colours as JavaScript strings and **copies them at `setOption` time**. So a chart
 * cannot simply reference `var(--color-chart-1)` and follow the theme — something has
 * to read the resolved values and re-apply them when the theme changes. That is this.
 *
 * ## Why the canvas round-trip
 *
 * `--color-chart-grid` resolves to `oklch(…)`, because it points at a ramp token and
 * the whole ramp is defined in oklch. zrender (ECharts' rendering layer) parses
 * colours itself and understands hex / rgb / hsl — **not oklch**. Assigning the value
 * to a canvas `fillStyle` and reading it back makes the browser do the conversion and
 * hands back `#rrggbb`, which works for every colour syntax the browser supports
 * rather than only the ones we happen to use today.
 */
const CHART_SLOTS = 8;

export interface ChartPalette {
  /** Series colours, in slot order. Assign in sequence and never cycle. */
  series: readonly string[];
  grid: string;
  axis: string;
  ink: string;
  inkMuted: string;
  surface: string;
  tooltipBorder: string;
}

const FALLBACK: ChartPalette = {
  series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"],
  grid: "#dbe5e6",
  axis: "#95a5a7",
  ink: "#182021",
  inkMuted: "#4b5859",
  surface: "#ffffff",
  tooltipBorder: "#dbe5e6",
};

let probe: CanvasRenderingContext2D | null = null;

/** Normalise any CSS colour to something zrender can parse. */
const toRenderable = (value: string, fallback: string): string => {
  const trimmed = value.trim();
  if (trimmed === "") return fallback;
  if (trimmed.startsWith("#") || trimmed.startsWith("rgb")) return trimmed;

  probe ??= document.createElement("canvas").getContext("2d");
  if (!probe) return fallback;

  // A value the browser rejects leaves fillStyle untouched, so seed it with a
  // sentinel and treat "unchanged" as "not understood".
  probe.fillStyle = "#000000";
  probe.fillStyle = trimmed;
  const resolved = probe.fillStyle;
  return typeof resolved === "string" && resolved !== "#000000"
    ? resolved
    : fallback;
};

const readToken = (name: string, fallback: string): string => {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  return toRenderable(raw, fallback);
};

const readPalette = (): ChartPalette => ({
  series: Array.from({ length: CHART_SLOTS }, (_unused, index) =>
    readToken(
      `--color-chart-${index + 1}`,
      FALLBACK.series[index % FALLBACK.series.length] ?? "#2a78d6",
    ),
  ),
  grid: readToken("--color-chart-grid", FALLBACK.grid),
  axis: readToken("--color-chart-axis", FALLBACK.axis),
  ink: readToken("--color-ink", FALLBACK.ink),
  inkMuted: readToken("--color-ink-muted", FALLBACK.inkMuted),
  surface: readToken("--color-surface-raised", FALLBACK.surface),
  tooltipBorder: readToken("--color-border", FALLBACK.tooltipBorder),
});

/**
 * Whether motion should be suppressed. ECharts animates by default, and an
 * operator who has asked their OS for reduced motion should not get 800ms of
 * easing on every telemetry update.
 */
const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const useChartTheme = () => {
  const { resolved } = useTheme();
  const palette = ref<ChartPalette>(readPalette());
  const animate = ref(!prefersReducedMotion());

  // `resolved` is the theme actually on screen, so this fires for a manual switch
  // and for the OS changing under a `system` preference. The attribute is written
  // by the same effect that updates `resolved`, and Vue flushes watchers after it,
  // so the values read here are the new ones.
  const stop = watch(resolved, () => {
    palette.value = readPalette();
  });
  onScopeDispose(stop);

  return { palette: readonly(palette), animate: readonly(animate) };
};

export const CHART_SERIES_SLOTS = CHART_SLOTS;
