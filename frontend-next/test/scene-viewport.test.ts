import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { computed, defineComponent, h, ref } from "vue";
import type { ComputedRef } from "vue";
import { mount } from "@vue/test-utils";
import { useSvgViewport } from "@/composables/useSvgViewport";
import type { WorldBounds } from "@/composables/useSvgViewport";
import {
  ROS_VIEW_STORAGE_KEY,
  VIEW_FLUSH_DELAY_MS,
  useSceneViewportPersistence,
  __resetSceneViewCache,
} from "@/composables/useSceneViewportPersistence";

/**
 * The pan/zoom engine, which arrived from v1.0.0 at **1.07% coverage** — 706 lines
 * whose only regression net was five e2e assertions.
 *
 * Each case below pins one of the behaviours whose comment in the source records a
 * defect that took several attempts to find. That is the point of writing them now
 * rather than later: the file is being carried into a second frontend, and "port it
 * unchanged" is only a safe instruction if something can tell you when it changed.
 *
 * The panel is 800x600 and the world is 100x50 m, which makes the numbers checkable
 * by hand: base scale is `min(800/100, 600/50) * 0.92` = 7.36.
 */
const PANEL = { width: 800, height: 600 };
const WORLD: WorldBounds = { minX: 0, maxX: 100, minY: 0, maxY: 50 };
const BASE_SCALE = 7.36;

const round = (value: number, digits: number): number =>
  Number(value.toFixed(digits));

interface HarnessOptions {
  bounds?: WorldBounds | null;
  scene?: Record<string, unknown>;
  device?: Record<string, unknown> | null;
  peers?: unknown[];
  extent?: WorldBounds | null;
  sceneId?: string;
}

const mountViewport = (options: HarnessOptions = {}) => {
  // `"bounds" in options` rather than `??`, because `null` is a meaningful value
  // here — it means "no scene yet" — and `??` would quietly substitute the world.
  const bounds = ref<WorldBounds | null>(
    "bounds" in options ? (options.bounds ?? null) : WORLD,
  );
  const scene = ref<Record<string, unknown>>(options.scene ?? {});
  const device = ref<Record<string, unknown> | null>(options.device ?? null);
  const peers = ref<unknown[]>(options.peers ?? []);
  const extent = ref<WorldBounds | null>(options.extent ?? null);
  const sceneId = ref(options.sceneId ?? "yard");

  let api: ReturnType<typeof useSvgViewport> | null = null;

  const Harness = defineComponent({
    setup() {
      api = useSvgViewport({
        round,
        selectedDevice: device as unknown as ComputedRef<null>,
        resolvedScene: scene as unknown as ComputedRef<Record<string, never>>,
        activeSceneId: sceneId as unknown as ComputedRef<string>,
        effectiveWorldBounds:
          bounds as unknown as ComputedRef<WorldBounds | null>,
        sceneReady: computed(() => bounds.value !== null),
        worldWidth: computed(() =>
          bounds.value ? bounds.value.maxX - bounds.value.minX : 1,
        ),
        worldHeight: computed(() =>
          bounds.value ? bounds.value.maxY - bounds.value.minY : 1,
        ),
        backgroundLayerDefinition: computed(() => null),
        formationPeerDevices: peers as unknown as ComputedRef<unknown[]>,
        deviceExtentBounds:
          extent as unknown as ComputedRef<WorldBounds | null>,
      });
      // Both refs point at the same element; jsdom has no layout, so the rect is
      // stubbed for every element anyway.
      return () =>
        h("div", { ref: api!.shellRef }, [h("svg", { ref: api!.svgRef })]);
    },
  });

  const wrapper = mount(Harness, { attachTo: document.body });
  return { wrapper, api: api!, bounds, scene, device, peers, extent, sceneId };
};

/** Where the view is centred, in world coordinates. */
const centreOf = (viewport: {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}) => ({
  x: WORLD.minX + (viewport.width / 2 - viewport.offsetX) / viewport.scale,
  y: WORLD.maxY - (viewport.height / 2 - viewport.offsetY) / viewport.scale,
});

const wheelAt = (
  clientX: number,
  clientY: number,
  deltaY: number,
): WheelEvent => ({ clientX, clientY, deltaY }) as WheelEvent;

const pointerAt = (
  clientX: number,
  clientY: number,
  extra: Partial<PointerEvent> = {},
): PointerEvent =>
  ({ clientX, clientY, pointerId: 1, button: 0, ...extra }) as PointerEvent;

beforeEach(() => {
  __resetSceneViewCache();
  sessionStorage.clear();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    ...PANEL,
    top: 0,
    left: 0,
    right: PANEL.width,
    bottom: PANEL.height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the first view", () => {
  it("frames the whole scene when there is nothing else to go on", () => {
    // FIXED in v1.0.0's Phase 9 and preserved here: this used to end with a 45 m
    // close-up whenever the selected vehicle had a pose — 22.22x on a 1000px panel,
    // which showed about a sixth of a 74x88 m site with the road network out of
    // frame.
    const { api } = mountViewport();

    expect(api.viewport.scale).toBeCloseTo(BASE_SCALE, 5);
    expect(centreOf(api.viewport)).toMatchObject({ x: 50, y: 25 });
  });

  it("waits for a measured panel instead of computing against the placeholder", () => {
    // The guard that fixes the hardest defect in this file: the bounds watcher runs
    // during setup, before `onMounted` measures anything, so a view computed then is
    // right for a 1000x620 panel that does not exist. Measured end to end in v1.0.0:
    // the vehicle ended up 274px off-centre in the real panel.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const { api } = mountViewport();
    // Nothing hydrated: the placeholder size is still in place and untouched.
    expect(api.viewport.width).toBe(1000);
    expect(api.viewport.height).toBe(620);
    expect(sessionStorage.getItem(ROS_VIEW_STORAGE_KEY)).toBeNull();
  });

  it("honours the scene's own default view when it declares one", () => {
    const { api } = mountViewport({
      scene: { defaultView: { zoom: 2, centerX: 10, centerY: 40 } },
    });

    expect(api.viewport.scale).toBeCloseTo(BASE_SCALE * 2, 5);
    expect(centreOf(api.viewport)).toMatchObject({ x: 10, y: 40 });
  });

  it("locates the selected vehicle rather than opening on the whole scene", () => {
    // Opening on the scene fit left the vehicle wherever it happened to be, so the
    // first thing an operator did on every visit was hunt for it and click 定位车辆.
    const { api } = mountViewport({
      device: { deviceId: "agv-01", fusionLoc: { x: 20, y: 10 } },
    });

    expect(centreOf(api.viewport).x).toBeCloseTo(20, 4);
    expect(centreOf(api.viewport).y).toBeCloseTo(10, 4);
    // 800 / 45 m beats 1.3x the base scale, so the close-up is the wider of the two.
    expect(api.viewport.scale).toBeCloseTo(800 / 45, 5);
  });
});

describe("focusing a vehicle", () => {
  it("puts the vehicle dead centre even when it sits at the edge of its formation", () => {
    // Fitting the raw extent frames the *formation*, which is not what "locate this
    // vehicle" means — measured at 262px from centre in a 637px panel, which is what
    // made the button look broken. The region is mirrored about the vehicle instead.
    const { api } = mountViewport({
      device: { deviceId: "agv-01", fusionLoc: { x: 10, y: 25 } },
      peers: [{}, {}],
      extent: { minX: 10, maxX: 90, minY: 20, maxY: 30 },
    });

    expect(api.focusSelectedDevice()).toBe(true);
    expect(centreOf(api.viewport).x).toBeCloseTo(10, 4);
  });

  it("falls back to framing the formation when the vehicle has no pose yet", () => {
    const { api } = mountViewport({
      device: { deviceId: "agv-01" },
      peers: [{}],
      extent: { minX: 20, maxX: 40, minY: 10, maxY: 20 },
    });

    expect(api.focusSelectedDevice()).toBe(true);
    expect(centreOf(api.viewport).x).toBeCloseTo(30, 4);
  });

  it("reports failure instead of moving the view when there is nothing to focus", () => {
    const { api } = mountViewport({ device: { deviceId: "agv-01" } });
    const before = { ...api.viewport };

    expect(api.focusSelectedDevice()).toBe(false);
    expect(api.viewport.offsetX).toBe(before.offsetX);
    expect(api.viewport.scale).toBe(before.scale);
  });

  it("locates the newly selected vehicle when the choice changes within a scene", async () => {
    const { api, device, wrapper } = mountViewport({
      device: {
        deviceId: "agv-01",
        sceneId: "yard",
        fusionLoc: { x: 20, y: 10 },
      },
    });

    device.value = {
      deviceId: "agv-02",
      sceneId: "yard",
      fusionLoc: { x: 80, y: 40 },
    };
    await wrapper.vm.$nextTick();

    expect(centreOf(api.viewport).x).toBeCloseTo(80, 4);
    expect(centreOf(api.viewport).y).toBeCloseTo(40, 4);
  });
});

describe("zoom", () => {
  it("keeps the point under the cursor fixed", () => {
    const { api } = mountViewport();
    const worldUnderCursor = {
      x: WORLD.minX + (200 - api.viewport.offsetX) / api.viewport.scale,
      y: WORLD.maxY - (150 - api.viewport.offsetY) / api.viewport.scale,
    };

    api.handleWheel(wheelAt(200, 150, -100));

    const after = {
      x: WORLD.minX + (200 - api.viewport.offsetX) / api.viewport.scale,
      y: WORLD.maxY - (150 - api.viewport.offsetY) / api.viewport.scale,
    };
    expect(after.x).toBeCloseTo(worldUnderCursor.x, 3);
    expect(after.y).toBeCloseTo(worldUnderCursor.y, 3);
    expect(api.viewport.scale).toBeGreaterThan(BASE_SCALE);
  });

  it("clamps to the scene's zoom limits", () => {
    const { api } = mountViewport({ scene: { minZoom: 1, maxZoom: 1.5 } });

    for (let step = 0; step < 20; step += 1)
      api.handleWheel(wheelAt(400, 300, -100));
    expect(api.viewport.scale).toBeCloseTo(BASE_SCALE * 1.5, 4);

    for (let step = 0; step < 40; step += 1)
      api.handleWheel(wheelAt(400, 300, 100));
    expect(api.viewport.scale).toBeCloseTo(BASE_SCALE * 1, 4);
  });

  it("ignores a wheel event that lands outside the scene", () => {
    const { api } = mountViewport();
    const before = api.viewport.scale;

    // The stubbed rect is 800x600 at the origin, so x=2000 is off the map.
    api.handleWheel(wheelAt(2000, 150, -100));
    expect(api.viewport.scale).toBe(before);
  });
});

describe("panning", () => {
  it("moves the view by the pointer delta", () => {
    const { api } = mountViewport();
    const startX = api.viewport.offsetX;

    api.handlePointerDown(pointerAt(100, 100));
    api.handlePointerMove(pointerAt(160, 100));

    expect(api.viewport.offsetX).toBe(startX + 60);
    expect(api.dragging.value).toBe(true);

    api.handlePointerUp(pointerAt(160, 100));
    expect(api.dragging.value).toBe(false);
  });

  it("ignores a pointer that is not the one that started the drag", () => {
    const { api } = mountViewport();
    const startX = api.viewport.offsetX;

    api.handlePointerDown(pointerAt(100, 100));
    api.handlePointerMove(pointerAt(500, 100, { pointerId: 9 }));

    expect(api.viewport.offsetX).toBe(startX);
  });

  it("ignores a non-primary button, so a right-click does not start a pan", () => {
    const { api } = mountViewport();
    api.handlePointerDown(pointerAt(100, 100, { button: 2 }));
    expect(api.dragging.value).toBe(false);
  });
});

describe("holding the view still when the world grows", () => {
  it("rebases the offsets so the view does not slide with the origin", async () => {
    // The lanelet overlay arriving widens the bounds, and the offsets are anchored
    // to `minX`/`maxY` — so without the correction every pixel slides by the delta.
    // Measured in v1.0.0 as a 199px drift in a 637px panel, immediately after the
    // initial focus, which read as "the map never located the vehicle".
    const { api, bounds, wrapper } = mountViewport({
      device: {
        deviceId: "agv-01",
        sceneId: "yard",
        fusionLoc: { x: 20, y: 10 },
      },
    });
    const before = centreOf(api.viewport);

    bounds.value = { minX: -50, maxX: 150, minY: -25, maxY: 75 };
    await wrapper.vm.$nextTick();

    const after = {
      x: bounds.value.minX + (400 - api.viewport.offsetX) / api.viewport.scale,
      y: bounds.value.maxY - (300 - api.viewport.offsetY) / api.viewport.scale,
    };
    expect(after.x).toBeCloseTo(before.x, 3);
    expect(after.y).toBeCloseTo(before.y, 3);
  });
});

describe("remembering the view", () => {
  it("restores the centre and scale this tab left behind", () => {
    sessionStorage.setItem(
      ROS_VIEW_STORAGE_KEY,
      JSON.stringify({
        yard: { centerX: 30, centerY: 15, scale: 12, updatedAt: Date.now() },
      }),
    );
    __resetSceneViewCache();

    const { api } = mountViewport({
      device: { deviceId: "agv-01", fusionLoc: { x: 90, y: 45 } },
    });

    // The saved view wins over locating the vehicle — you left it here on purpose.
    expect(api.viewport.scale).toBeCloseTo(12, 5);
    expect(centreOf(api.viewport).x).toBeCloseTo(30, 3);
  });

  it("rejects a saved centre that is outside the current scene", () => {
    // A scene can shrink between visits, and re-applying a centre outside it would
    // open the map on empty space.
    sessionStorage.setItem(
      ROS_VIEW_STORAGE_KEY,
      JSON.stringify({
        yard: {
          centerX: 5000,
          centerY: 5000,
          scale: 12,
          updatedAt: Date.now(),
        },
      }),
    );
    __resetSceneViewCache();

    const { api } = mountViewport();
    expect(api.viewport.scale).toBeCloseTo(BASE_SCALE, 5);
  });

  it("clamps a saved scale rather than trusting it", () => {
    sessionStorage.setItem(
      ROS_VIEW_STORAGE_KEY,
      JSON.stringify({
        yard: { centerX: 50, centerY: 25, scale: 9999, updatedAt: Date.now() },
      }),
    );
    __resetSceneViewCache();

    const { api } = mountViewport({ scene: { maxZoom: 2 } });
    expect(api.viewport.scale).toBeCloseTo(BASE_SCALE * 2, 4);
  });

  it("keeps each scene's view separately", async () => {
    const { api, sceneId, wrapper } = mountViewport();
    api.handleWheel(wheelAt(400, 300, -100));
    const yardScale = api.viewport.scale;

    sceneId.value = "dock";
    await wrapper.vm.$nextTick();
    useSceneViewportPersistence().flushSavedSceneViews();

    const stored = JSON.parse(
      sessionStorage.getItem(ROS_VIEW_STORAGE_KEY) ?? "{}",
    ) as Record<string, { scale: number }>;
    expect(stored.yard?.scale).toBeCloseTo(yardScale, 5);
    expect(stored.dock).toBeDefined();
  });
});

describe("storage that will not cooperate", () => {
  /**
   * Private browsing and a full quota are the two ways this fails in the field, and
   * neither should cost anyone the map. The view still applies for the session; it
   * just will not survive a reload.
   */
  const persistence = () => useSceneViewportPersistence();

  it("reads an empty set when sessionStorage cannot even be reached", () => {
    __resetSceneViewCache();
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    expect(persistence().readSavedSceneViews()).toEqual({});
  });

  it("reads an empty set when the stored value is not JSON", () => {
    sessionStorage.setItem(ROS_VIEW_STORAGE_KEY, "{not json");
    __resetSceneViewCache();

    expect(persistence().readSavedSceneViews()).toEqual({});
  });

  it("reads an empty set when the stored value is JSON but not an object", () => {
    sessionStorage.setItem(ROS_VIEW_STORAGE_KEY, '"a string"');
    __resetSceneViewCache();

    expect(persistence().readSavedSceneViews()).toEqual({});
  });

  it("swallows a quota failure instead of breaking the map", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    const api = persistence();
    api.writeSavedSceneViews({
      yard: { centerX: 1, centerY: 2, scale: 3, updatedAt: 4 },
    });
    expect(() => api.flushSavedSceneViews()).not.toThrow();
    // The in-memory copy is still authoritative for this session.
    expect(api.readSavedSceneViews().yard?.scale).toBe(3);
  });

  it("forgets everything on request, in memory and in storage", () => {
    const api = persistence();
    api.writeSavedSceneViews({
      yard: { centerX: 1, centerY: 2, scale: 3, updatedAt: 4 },
    });
    api.flushSavedSceneViews();

    api.clearSavedSceneViews();
    expect(api.readSavedSceneViews()).toEqual({});
    expect(sessionStorage.getItem(ROS_VIEW_STORAGE_KEY)).toBeNull();
  });

  it("flushes a pending write when the tab goes away", () => {
    // `pagehide` rather than `beforeunload`: it is the one that fires when a mobile
    // browser or a background tab is discarded, which is exactly when a coalesced
    // write would otherwise be lost.
    const { api } = mountViewport();
    api.handleWheel(wheelAt(400, 300, -100));
    sessionStorage.clear();

    window.dispatchEvent(new Event("pagehide"));

    expect(sessionStorage.getItem(ROS_VIEW_STORAGE_KEY)).toContain("yard");
  });
});

describe("re-hydrating", () => {
  it("re-hydrates from scratch when the selected vehicle is in another scene", async () => {
    const { api, device, sceneId, wrapper } = mountViewport({
      device: {
        deviceId: "agv-01",
        sceneId: "yard",
        fusionLoc: { x: 20, y: 10 },
      },
    });

    sceneId.value = "dock";
    device.value = {
      deviceId: "agv-09",
      sceneId: "dock",
      fusionLoc: { x: 70, y: 30 },
    };
    await wrapper.vm.$nextTick();

    expect(centreOf(api.viewport).x).toBeCloseTo(70, 4);
  });

  it("falls back to framing the scene when the new selection has no pose yet", async () => {
    const { api, device, wrapper } = mountViewport({
      device: {
        deviceId: "agv-01",
        sceneId: "yard",
        fusionLoc: { x: 20, y: 10 },
      },
    });

    device.value = { deviceId: "agv-02", sceneId: "yard" };
    await wrapper.vm.$nextTick();

    expect(api.viewport.scale).toBeCloseTo(BASE_SCALE, 5);
    expect(centreOf(api.viewport)).toMatchObject({ x: 50, y: 25 });
  });

  it("re-hydrates when the world shrinks out from under the current centre", async () => {
    // A scene can shrink between snapshots. The centre this tab saved is now outside
    // it, and re-applying it would leave the map looking at nothing — so the saved
    // entry is rejected and the view falls back to framing what is actually there.
    // (The vehicle here has no pose, so the fallback is unambiguous; with one, the
    // map centres on the vehicle instead — telemetry outranks a remembered view.)
    const { api, bounds, wrapper } = mountViewport();
    expect(centreOf(api.viewport).x).toBeCloseTo(50, 3);

    bounds.value = { minX: 0, maxX: 20, minY: 0, maxY: 10 };
    await wrapper.vm.$nextTick();

    const centre = {
      x: bounds.value.minX + (400 - api.viewport.offsetX) / api.viewport.scale,
      y: bounds.value.maxY - (300 - api.viewport.offsetY) / api.viewport.scale,
    };
    expect(centre.x).toBeCloseTo(10, 3);
    expect(centre.y).toBeCloseTo(5, 3);
  });

  it("does nothing at all while the scene is not ready", async () => {
    const { api, bounds, wrapper } = mountViewport({ bounds: null });
    const before = { ...api.viewport };

    api.handleWheel(wheelAt(400, 300, -100));
    api.handlePointerDown(pointerAt(100, 100));
    expect(api.viewport.scale).toBe(before.scale);
    expect(api.dragging.value).toBe(false);
    expect(api.focusSelectedDevice()).toBe(false);

    // …and picks up as soon as it is.
    bounds.value = WORLD;
    await wrapper.vm.$nextTick();
    expect(api.viewport.scale).toBeCloseTo(BASE_SCALE, 5);
  });
});

describe("resizing the panel", () => {
  /**
   * The global stub in `test/setup.ts` is inert, which is right for every other
   * suite — but the resize path is 20 lines of this file, and a panel that changes
   * size is an ordinary thing here (opening the detail pane, rotating a tablet). So
   * this suite installs an observer it can actually fire.
   */
  let fireResize: (() => void) | null = null;

  beforeEach(() => {
    fireResize = null;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          fireResize = callback;
        }
        observe = (): void => undefined;
        unobserve = (): void => undefined;
        disconnect = (): void => undefined;
      },
    );
  });

  const setPanel = (width: number, height: number): void => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  };

  it("keeps looking at the same place when the panel changes size", () => {
    const { api } = mountViewport();
    api.handleWheel(wheelAt(300, 200, -100));
    const before = centreOf(api.viewport);

    setPanel(500, 400);
    fireResize?.();

    expect(api.viewport.width).toBe(500);
    expect(centreOf(api.viewport).x).toBeCloseTo(before.x, 3);
    expect(centreOf(api.viewport).y).toBeCloseTo(before.y, 3);
  });

  it("re-clamps the scale a smaller panel no longer allows", () => {
    const { api } = mountViewport({ scene: { minZoom: 1, maxZoom: 1 } });
    // With min == max the only legal scale is the base one, which depends on the
    // panel — so shrinking the panel has to move it.
    setPanel(400, 300);
    fireResize?.();

    const baseAfter = Math.min(400 / 100, 300 / 50) * 0.92;
    expect(api.viewport.scale).toBeCloseTo(baseAfter, 5);
  });

  it("does nothing while there is no scene", () => {
    const { api } = mountViewport({ bounds: null });
    setPanel(500, 400);
    fireResize?.();

    // The measurement lands, the view stays put: there is no world to preserve.
    expect(api.viewport.width).toBe(500);
    expect(api.viewport.scale).toBe(1);
  });
});

describe("write coalescing", () => {
  it("does not touch storage on every wheel tick", () => {
    // v1.0.0 did a synchronous getItem + JSON.parse *and* a stringify + setItem per
    // save, and `saveViewportState` is called from the wheel handler — 60–120 storage
    // round-trips a second on the main thread, inside an input handler.
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { api } = mountViewport();
    setItem.mockClear();

    for (let tick = 0; tick < 30; tick += 1) {
      api.handleWheel(wheelAt(400, 300, -100));
    }
    expect(setItem).not.toHaveBeenCalled();
  });

  it("flushes on the timer", () => {
    vi.useFakeTimers();
    try {
      const { api } = mountViewport();
      api.handleWheel(wheelAt(400, 300, -100));
      const setItem = vi.spyOn(Storage.prototype, "setItem");

      vi.advanceTimersByTime(VIEW_FLUSH_DELAY_MS);
      expect(setItem).toHaveBeenCalledWith(
        ROS_VIEW_STORAGE_KEY,
        expect.stringContaining("yard"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes when the map is unmounted, rather than losing the last write", () => {
    const { api, wrapper } = mountViewport();
    api.handleWheel(wheelAt(400, 300, -100));
    const expected = api.viewport.scale;

    wrapper.unmount();

    const stored = JSON.parse(
      sessionStorage.getItem(ROS_VIEW_STORAGE_KEY) ?? "{}",
    ) as Record<string, { scale: number }>;
    expect(stored.yard?.scale).toBeCloseTo(expected, 5);
  });
});
