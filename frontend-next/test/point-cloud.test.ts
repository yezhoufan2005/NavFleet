import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BACKDROP_CACHE_LIMIT,
  loadPointCloudBackdrop,
  __cachedBackdropCount,
  __clearBackdropCache,
} from "@/lib/pointCloudBackdrop";
import type { PointCloudPalette } from "@/lib/pointCloudBackdrop";

/**
 * The cache, which is where this module's own two fixes are. The rasterization it
 * wraps is tested in `@navfleet/fleet-core` (23 cases) — here the questions are
 * whether a theme switch produces a new image and whether the cache can grow without
 * limit.
 */
const DARK: PointCloudPalette = {
  obstacle: [182, 237, 255],
  floor: [108, 132, 148],
};
const LIGHT: PointCloudPalette = {
  obstacle: [20, 60, 90],
  floor: [180, 190, 200],
};

const SCENE = {
  pointCloudUrl: "/scenes/yard.pcd",
  resolution: 1,
  origin: { x: 0, y: 0, yaw: 0 },
  width: 2,
  height: 2,
};

/** A one-point binary PCD, which is enough for the pipeline to produce a raster. */
const pcdBuffer = (): ArrayBuffer => {
  const header =
    "# .PCD v0.7\nVERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\n" +
    "COUNT 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary\n";
  const headerBytes = new TextEncoder().encode(header);
  const buffer = new ArrayBuffer(headerBytes.length + 12);
  new Uint8Array(buffer).set(headerBytes, 0);
  const view = new DataView(buffer);
  view.setFloat32(headerBytes.length, 0.5, true);
  view.setFloat32(headerBytes.length + 4, 0.5, true);
  view.setFloat32(headerBytes.length + 8, 0, true);
  return buffer;
};

let fetchMock: ReturnType<typeof vi.fn>;
let toDataUrlCalls = 0;

/**
 * jsdom ships no 2D context, so `getContext` returns null and the rasterizer would
 * throw its "cannot create canvas" error. The stub is the smallest thing that
 * satisfies the three calls the module makes, and counting `toDataURL` is how these
 * tests tell a cache hit from a re-render.
 */
const installCanvasStub = (): void => {
  toDataUrlCalls = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
      width,
      height,
      colorSpace: "srgb",
    }),
    putImageData: () => undefined,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
    toDataUrlCalls += 1;
    return `data:image/png;base64,stub${toDataUrlCalls}`;
  });
};

beforeEach(() => {
  __clearBackdropCache();
  installCanvasStub();
  fetchMock = vi.fn(() =>
    Promise.resolve(new Response(pcdBuffer(), { status: 200 })),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("loading", () => {
  it("returns nothing for a scene with no cloud, without fetching", async () => {
    await expect(loadPointCloudBackdrop({}, DARK)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rasterizes to a data URL with the grid's bounds", async () => {
    const backdrop = await loadPointCloudBackdrop(SCENE, DARK);

    expect(backdrop?.dataUrl).toMatch(/^data:image\/png/);
    expect(backdrop).toMatchObject({
      width: 2,
      height: 2,
      bounds: { minX: 0, maxX: 2, minY: 0, maxY: 2 },
    });
  });

  it("fetches the metadata document when the scene names one", async () => {
    // Two endpoints, two shapes: the cloud is binary and the metadata is JSON, so a
    // single canned response would have the JSON parse eat the PCD header.
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).endsWith(".json")
          ? new Response(JSON.stringify({ grid_size: 1 }), { status: 200 })
          : new Response(pcdBuffer(), { status: 200 }),
      ),
    );

    await loadPointCloudBackdrop(
      { ...SCENE, pointCloudMetaUrl: "/scenes/yard.json" },
      DARK,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports an HTTP failure rather than resolving to an empty backdrop", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(loadPointCloudBackdrop(SCENE, DARK)).rejects.toThrow(/404/);
  });
});

describe("the cache", () => {
  it("serves a repeat request without re-fetching", async () => {
    await loadPointCloudBackdrop(SCENE, DARK);
    await loadPointCloudBackdrop(SCENE, DARK);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toDataUrlCalls).toBe(1);
  });

  it("rasterizes again when the palette changes", async () => {
    // FIXED: the palette used to be hardcoded. Making it an argument without keying
    // the cache on it would be worse than leaving it alone — switching themes would
    // serve the PNG built for the previous one, and it would look like the switch had
    // silently failed.
    const dark = await loadPointCloudBackdrop(SCENE, DARK);
    const light = await loadPointCloudBackdrop(SCENE, LIGHT);

    expect(toDataUrlCalls).toBe(2);
    expect(light?.dataUrl).not.toBe(dark?.dataUrl);
  });

  it("keeps both themes cached, so switching back is instant", async () => {
    await loadPointCloudBackdrop(SCENE, DARK);
    await loadPointCloudBackdrop(SCENE, LIGHT);
    await loadPointCloudBackdrop(SCENE, DARK);

    expect(toDataUrlCalls).toBe(2);
  });

  it("stops growing at its limit", async () => {
    // FIXED: v1.0.0 never evicted. Each entry is a whole scene as a base64 PNG, so a
    // console left open across a shift's worth of scenes — doubled by themes — grew a
    // set of multi-megabyte strings that nothing could reclaim.
    for (let index = 0; index < BACKDROP_CACHE_LIMIT + 3; index += 1) {
      await loadPointCloudBackdrop(
        { ...SCENE, pointCloudUrl: `/scenes/scene-${index}.pcd` },
        DARK,
      );
    }
    expect(__cachedBackdropCount()).toBe(BACKDROP_CACHE_LIMIT);
  });

  it("evicts the coldest entry, not the most recently used one", async () => {
    const first = { ...SCENE, pointCloudUrl: "/scenes/first.pcd" };
    await loadPointCloudBackdrop(first, DARK);

    // Fill the cache, touching `first` again along the way so it is not the coldest.
    for (let index = 0; index < BACKDROP_CACHE_LIMIT - 1; index += 1) {
      await loadPointCloudBackdrop(
        { ...SCENE, pointCloudUrl: `/scenes/filler-${index}.pcd` },
        DARK,
      );
      await loadPointCloudBackdrop(first, DARK);
    }
    fetchMock.mockClear();
    await loadPointCloudBackdrop(
      { ...SCENE, pointCloudUrl: "/scenes/last.pcd" },
      DARK,
    );

    await loadPointCloudBackdrop(first, DARK);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only `last`, so `first` survived
  });

  it("does not remember a failure as a result", async () => {
    // A cached rejection would keep failing forever, including after the network
    // came back.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    await expect(loadPointCloudBackdrop(SCENE, DARK)).rejects.toThrow();

    await expect(loadPointCloudBackdrop(SCENE, DARK)).resolves.toMatchObject({
      width: 2,
    });
  });
});
