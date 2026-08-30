import type { SceneMapDefinition } from "@navfleet/shared";

/**
 * Point-cloud rasterization, minus the canvas.
 *
 * Split out of the v1.0.0 frontend's `utils/point-cloud.ts` so that the part with
 * all the arithmetic in it can be tested and shared: a binary PCD header parser, a
 * geometry derivation with three layers of fallback, a z-band classifier, and the
 * loop that turns points into an occupancy grid. None of it touches the DOM, which
 * is what lets both frontends import it instead of each keeping a copy honest.
 *
 * What stays in the frontends is the last 20 lines of the old file: putting the
 * pixels on a `<canvas>` and asking it for a data URL. That genuinely needs a
 * document, and it is also the only part that had no logic worth testing.
 *
 * The PCD reading here is deliberately narrow — binary `DATA binary` only, which is
 * what the scenes in this project ship. It is not a general PCD library and should
 * not grow into one.
 */

export interface PointCloudBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Loose shape of the optional point-cloud metadata JSON (all fields optional). */
export interface PointCloudMeta {
  grid_size?: unknown;
  origin?: { x?: unknown; y?: unknown };
  shape?: { width?: unknown; height?: unknown };
  floor_band?: { min_z?: unknown; max_z?: unknown };
  obstacle_band?: { min_z?: unknown; max_z?: unknown };
}

export interface PcdFieldDescriptor {
  name: string;
  size: number;
  type: string;
  count: number;
  offset: number;
}

export interface PcdHeader {
  headerLength: number;
  pointCount: number;
  pointStride: number;
  fields: PcdFieldDescriptor[];
}

export interface PointCloudGeometry {
  gridSize: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  bounds: PointCloudBounds;
}

/**
 * What one cell of the grid turned out to be.
 *
 * `Obstacle` beats `Floor` when both land in the same cell — a cell you can drive
 * over and also bump into is a cell you cannot drive over.
 */
export const CELL_EMPTY = 0;
export const CELL_FLOOR = 1;
export const CELL_OBSTACLE = 2;

export interface OccupancyGrid {
  geometry: PointCloudGeometry;
  /** One of the `CELL_*` values per cell, row-major from the world origin up. */
  occupancy: Uint8Array;
  /** Peak intensity per cell, 0–255. */
  intensity: Uint8Array;
}

type ScenePart = Partial<SceneMapDefinition>;

const HEADER_SCAN_BYTES = 64 * 1024;
const ASCII_DECODER = new TextDecoder("ascii");

const toFiniteNumber = (
  value: unknown,
  fallback: number | null = null,
): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

export const parsePcdHeader = (arrayBuffer: ArrayBuffer): PcdHeader => {
  const headerSlice = new Uint8Array(
    arrayBuffer,
    0,
    Math.min(arrayBuffer.byteLength, HEADER_SCAN_BYTES),
  );
  const headerText = ASCII_DECODER.decode(headerSlice);
  const match = headerText.match(/DATA\s+binary[^\r\n]*\r?\n/i);

  if (!match || match.index === undefined) {
    throw new Error("暂不支持当前 PCD 格式，未找到 DATA binary 头信息");
  }

  const headerLength = match.index + match[0].length;
  const lines = headerText
    .slice(0, headerLength)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const header: Record<string, string[]> = {};

  lines.forEach((line) => {
    const [keyword, ...rest] = line.split(/\s+/);
    if (keyword) header[keyword.toUpperCase()] = rest;
  });

  const fields = header.FIELDS || [];
  const sizes = (header.SIZE || []).map((value) => Number(value));
  const types = header.TYPE || [];
  const counts = (header.COUNT || []).map((value) => Number(value));

  let runningOffset = 0;
  const descriptors: PcdFieldDescriptor[] = fields.map((name, index) => {
    const descriptor: PcdFieldDescriptor = {
      name,
      size: sizes[index] || 4,
      type: types[index] || "F",
      count: counts[index] || 1,
      offset: runningOffset,
    };
    runningOffset += descriptor.size * descriptor.count;
    return descriptor;
  });

  const width = Number(header.WIDTH?.[0] || 0);
  const height = Number(header.HEIGHT?.[0] || 1);
  const points = Number(header.POINTS?.[0] || width * height || 0);

  return {
    headerLength,
    pointCount: points,
    pointStride: runningOffset,
    fields: descriptors,
  };
};

/** Reads one PCD scalar. `NaN` for a field this reader does not handle. */
export const readScalar = (
  dataView: DataView,
  offset: number,
  descriptor: PcdFieldDescriptor | undefined,
): number => {
  if (!descriptor || descriptor.count !== 1) return Number.NaN;

  const littleEndian = true;
  const { type, size } = descriptor;
  if (type === "F" && size === 4)
    return dataView.getFloat32(offset, littleEndian);
  if (type === "F" && size === 8)
    return dataView.getFloat64(offset, littleEndian);
  if (type === "I" && size === 1) return dataView.getInt8(offset);
  if (type === "I" && size === 2)
    return dataView.getInt16(offset, littleEndian);
  if (type === "I" && size === 4)
    return dataView.getInt32(offset, littleEndian);
  if (type === "U" && size === 1) return dataView.getUint8(offset);
  if (type === "U" && size === 2)
    return dataView.getUint16(offset, littleEndian);
  if (type === "U" && size === 4)
    return dataView.getUint32(offset, littleEndian);

  return Number.NaN;
};

/**
 * Grid geometry, from the metadata JSON if it has it, else the scene definition,
 * else a 0.2 m grid at the origin. Three layers because the three sources are
 * independently optional in practice.
 */
export const derivePointCloudGeometry = (
  sceneDefinition: ScenePart = {},
  meta: PointCloudMeta = {},
): PointCloudGeometry => {
  const gridSize =
    toFiniteNumber(
      meta.grid_size,
      toFiniteNumber(sceneDefinition.resolution, 0.2),
    ) || 0.2;
  const originX =
    toFiniteNumber(
      meta.origin?.x,
      toFiniteNumber(sceneDefinition.origin?.x, 0),
    ) || 0;
  const originY =
    toFiniteNumber(
      meta.origin?.y,
      toFiniteNumber(sceneDefinition.origin?.y, 0),
    ) || 0;
  const width = Math.max(
    1,
    Math.round(
      toFiniteNumber(
        meta.shape?.width,
        toFiniteNumber(sceneDefinition.width, 1),
      ) || 1,
    ),
  );
  const height = Math.max(
    1,
    Math.round(
      toFiniteNumber(
        meta.shape?.height,
        toFiniteNumber(sceneDefinition.height, 1),
      ) || 1,
    ),
  );

  return {
    gridSize,
    originX,
    originY,
    width,
    height,
    bounds: {
      minX: originX,
      maxX: originX + width * gridSize,
      minY: originY,
      maxY: originY + height * gridSize,
    },
  };
};

/**
 * Which class a point's height puts it in.
 *
 * With neither band configured everything counts as floor — a cloud with no z
 * banding still has to draw something, and "all obstacle" would render a solid
 * block. With only one band configured, points outside it are dropped rather than
 * guessed at.
 */
export const classifyPoint = (pointZ: number, meta: PointCloudMeta): number => {
  const floorMin = toFiniteNumber(meta.floor_band?.min_z);
  const floorMax = toFiniteNumber(meta.floor_band?.max_z);
  const obstacleMin = toFiniteNumber(meta.obstacle_band?.min_z);
  const obstacleMax = toFiniteNumber(meta.obstacle_band?.max_z);

  if (
    Number.isFinite(obstacleMin) &&
    Number.isFinite(obstacleMax) &&
    pointZ >= (obstacleMin as number) &&
    pointZ <= (obstacleMax as number)
  ) {
    return CELL_OBSTACLE;
  }

  if (
    Number.isFinite(floorMin) &&
    Number.isFinite(floorMax) &&
    pointZ >= (floorMin as number) &&
    pointZ <= (floorMax as number)
  ) {
    return CELL_FLOOR;
  }

  if (!Number.isFinite(obstacleMin) && !Number.isFinite(floorMin)) {
    return CELL_FLOOR;
  }

  return CELL_EMPTY;
};

/** Bins every point of a binary PCD into the grid the geometry describes. */
export const buildOccupancyGrid = (
  arrayBuffer: ArrayBuffer,
  meta: PointCloudMeta,
  sceneDefinition: ScenePart,
): OccupancyGrid => {
  const geometry = derivePointCloudGeometry(sceneDefinition, meta);
  const { width, height, gridSize, originX, originY } = geometry;
  const occupancy = new Uint8Array(width * height);
  const intensity = new Uint8Array(width * height);
  const dataView = new DataView(arrayBuffer);
  const header = parsePcdHeader(arrayBuffer);
  const fieldMap: Record<string, PcdFieldDescriptor> = Object.fromEntries(
    header.fields.map((field) => [field.name, field]),
  );

  for (let index = 0; index < header.pointCount; index += 1) {
    const baseOffset = header.headerLength + index * header.pointStride;
    if (baseOffset + header.pointStride > arrayBuffer.byteLength) break;

    const x = readScalar(
      dataView,
      baseOffset + (fieldMap.x?.offset || 0),
      fieldMap.x,
    );
    const y = readScalar(
      dataView,
      baseOffset + (fieldMap.y?.offset || 0),
      fieldMap.y,
    );
    const z = readScalar(
      dataView,
      baseOffset + (fieldMap.z?.offset || 0),
      fieldMap.z,
    );
    const pointIntensity = readScalar(
      dataView,
      baseOffset + (fieldMap.intensity?.offset || 0),
      fieldMap.intensity,
    );

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }

    const cellX = Math.floor((x - originX) / gridSize);
    const cellY = Math.floor((y - originY) / gridSize);
    if (cellX < 0 || cellX >= width || cellY < 0 || cellY >= height) continue;

    const cellIndex = cellY * width + cellX;
    const nextClass = classifyPoint(z, meta);
    if (
      nextClass === CELL_OBSTACLE ||
      (nextClass === CELL_FLOOR && occupancy[cellIndex] !== CELL_OBSTACLE)
    ) {
      occupancy[cellIndex] = nextClass;
    }

    if (Number.isFinite(pointIntensity)) {
      intensity[cellIndex] = Math.max(
        intensity[cellIndex] ?? 0,
        Math.max(0, Math.min(255, Math.round(pointIntensity))),
      );
    }
  }

  return { geometry, occupancy, intensity };
};

/**
 * The two colours the backdrop is drawn in, and how opaque each may get.
 *
 * A parameter rather than a constant, and that is **a fix, not a port**: v1.0.0
 * wrote `rgb(182,237,255)` and `rgb(108,132,148)` straight into the pixel loop —
 * values picked for a dark canvas. On the light theme the backdrop was therefore
 * drawn for the wrong background, and no amount of CSS could correct it because by
 * then it was a PNG. Whoever calls this must also put the palette in the cache key;
 * see `pointCloudBackdrop.ts` for why a theme switch otherwise serves a stale image.
 *
 * **The alphas are part of the palette, not constants, and that is not a knob for
 * its own sake.** How opaque a wash has to be depends on what it is drawn over: a
 * translucent pale wash reads clearly on a near-black canvas, and the same 64%
 * opacity on a near-white one cannot reach 3:1 contrast *whatever colour it is* —
 * the canvas showing through the remaining 36% sets a luminance floor above the one
 * 3:1 allows. Machine-checked in `docs/tools/check-map-contrast.mjs`, which is what
 * found that; the light theme therefore uses a higher obstacle floor.
 */
export interface PointCloudPalette {
  obstacle: readonly [number, number, number];
  floor: readonly [number, number, number];
  /** Defaults are v1.0.0's values, so an omitted `alpha` reproduces its output. */
  alpha?: {
    /** Obstacles never fade below this, however low the reported intensity. */
    obstacleMin?: number;
    floorMin?: number;
    floorMax?: number;
    /** What a floor cell that reported no intensity at all is drawn at. */
    floorDefault?: number;
  };
}

const LEGACY_ALPHA = {
  obstacleMin: 164,
  floorMin: 64,
  floorMax: 146,
  floorDefault: 82,
} as const;

/**
 * Grid → RGBA pixels, row-flipped.
 *
 * The flip is not cosmetic: world y grows upward and image rows grow downward, so
 * a raster written in grid order is vertically mirrored against the vehicles drawn
 * on top of it.
 *
 * The alpha curves keep the backdrop readable without competing with the vehicle
 * markers: obstacles never fade below `obstacleMin`, floor is held between
 * `floorMin` and `floorMax`, and a floor cell that reported no intensity at all
 * still draws at `floorDefault` rather than vanishing.
 */
export const paintOccupancy = (
  grid: OccupancyGrid,
  palette: PointCloudPalette,
): Uint8ClampedArray => {
  const { width, height } = grid.geometry;
  const alpha = { ...LEGACY_ALPHA, ...palette.alpha };
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let cellY = 0; cellY < height; cellY += 1) {
    for (let cellX = 0; cellX < width; cellX += 1) {
      const sourceIndex = cellY * width + cellX;
      const pixelIndex = ((height - 1 - cellY) * width + cellX) * 4;
      const pointClass = grid.occupancy[sourceIndex];
      const intensity = grid.intensity[sourceIndex] ?? 0;

      if (pointClass === CELL_OBSTACLE) {
        pixels[pixelIndex] = palette.obstacle[0];
        pixels[pixelIndex + 1] = palette.obstacle[1];
        pixels[pixelIndex + 2] = palette.obstacle[2];
        pixels[pixelIndex + 3] = Math.max(alpha.obstacleMin, intensity);
        continue;
      }

      if (pointClass === CELL_FLOOR) {
        pixels[pixelIndex] = palette.floor[0];
        pixels[pixelIndex + 1] = palette.floor[1];
        pixels[pixelIndex + 2] = palette.floor[2];
        pixels[pixelIndex + 3] = Math.max(
          alpha.floorMin,
          Math.min(
            alpha.floorMax,
            Math.round(intensity * 0.75) || alpha.floorDefault,
          ),
        );
      }
    }
  }

  return pixels;
};
