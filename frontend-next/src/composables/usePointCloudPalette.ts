import { computed, onScopeDispose, ref, watch } from "vue";
import type { PointCloudPalette } from "@/lib/pointCloudBackdrop";
import { useTheme } from "@/composables/useTheme";

/**
 * Resolves the point-cloud tokens into the numbers the rasterizer needs.
 *
 * Same shape of problem as `useChartTheme`, for the same reason: the tokens are CSS
 * custom properties the browser resolves per theme, but the rasterizer writes bytes
 * into an `ImageData` buffer and needs `[r, g, b]` plus an alpha. Something has to
 * read the resolved values and hand them over — and re-hand them when the theme
 * changes, because the result is baked into a PNG.
 *
 * The alphas are tokens too, and deliberately: on a near-white canvas a 64%-opaque
 * wash cannot reach 3:1 contrast *whatever colour it is*, so the light theme raises
 * its obstacle floor. Keeping the alphas beside the colours is what lets
 * `docs/tools/check-map-contrast.mjs` verify the combination that will actually be
 * drawn rather than a restatement of it.
 */

/** v1.0.0's dark values, for the case where no stylesheet has loaded yet. */
const FALLBACK: PointCloudPalette = {
  obstacle: [182, 237, 255],
  floor: [108, 132, 148],
  alpha: { obstacleMin: 164, floorDefault: 82 },
};

let probe: CanvasRenderingContext2D | null = null;

/**
 * Any CSS colour → `[r, g, b]`.
 *
 * The canvas round-trip is what makes this work for a token whose value is `oklch()`
 * (as the ramp-derived ones are): the browser does the conversion, and we get a
 * concrete `rgb(...)` back rather than having to implement colour spaces here.
 */
const parseRgb = (value: string): [number, number, number] | null => {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex) {
    return [
      Number.parseInt(hex[1] as string, 16),
      Number.parseInt(hex[2] as string, 16),
      Number.parseInt(hex[3] as string, 16),
    ];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
};

const toRgb = (
  value: string,
  fallback: readonly [number, number, number],
): [number, number, number] => {
  const trimmed = value.trim();
  if (trimmed === "") return [...fallback];

  // The cloud tokens are literal hex today, so parse them directly: creating a canvas
  // to read back a value we can already read is work for nothing, and it is the only
  // reason this would need a DOM at all.
  const direct = parseRgb(trimmed);
  if (direct) return direct;

  if (typeof document === "undefined") return [...fallback];
  probe ??= document.createElement("canvas").getContext("2d");
  if (!probe) return [...fallback];

  probe.fillStyle = "#000000";
  probe.fillStyle = trimmed;
  const resolved = probe.fillStyle;
  if (typeof resolved !== "string" || resolved === "#000000") {
    // Either the browser rejected it or it really is black; the two are
    // indistinguishable here, and a black backdrop is never what a token means.
    return [...fallback];
  }
  return parseRgb(resolved) ?? [...fallback];
};

const readVar = (name: string): string =>
  typeof document === "undefined"
    ? ""
    : getComputedStyle(document.documentElement).getPropertyValue(name);

const readNumber = (name: string, fallback: number): number => {
  const value = Number(readVar(name).trim());
  return Number.isFinite(value) ? value : fallback;
};

const readPalette = (): PointCloudPalette => ({
  obstacle: toRgb(readVar("--color-ros-cloud-obstacle"), FALLBACK.obstacle),
  floor: toRgb(readVar("--color-ros-cloud-floor"), FALLBACK.floor),
  alpha: {
    obstacleMin: readNumber("--ros-cloud-obstacle-alpha", 164),
    floorDefault: readNumber("--ros-cloud-floor-alpha", 82),
  },
});

export const usePointCloudPalette = () => {
  const { resolved } = useTheme();
  const palette = ref<PointCloudPalette>(readPalette());

  const stop = watch(resolved, () => {
    palette.value = readPalette();
  });
  onScopeDispose(stop);

  return {
    palette: computed(() => palette.value),
    /** For a caller that needs a plain getter, e.g. `useSceneOverlay`. */
    getPalette: (): PointCloudPalette => palette.value,
  };
};
