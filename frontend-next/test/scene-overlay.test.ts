import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { defineComponent, h, ref } from "vue";
import { flushPromises, mount } from "@vue/test-utils";
import { useSceneOverlay } from "@/composables/useSceneOverlay";
import type { PointCloudPalette } from "@/lib/pointCloudBackdrop";
import {
  useNotifications,
  __resetNotifications,
} from "@/composables/useNotifications";

/**
 * The three optional scene assets, and two things that are easy to get wrong:
 * whether a slow load for a scene you have left can still land, and whether a theme
 * change produces a new raster.
 */
const backdropMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/pointCloudBackdrop", () => ({
  loadPointCloudBackdrop: backdropMock,
}));

const DARK: PointCloudPalette = { obstacle: [1, 2, 3], floor: [4, 5, 6] };
const LIGHT: PointCloudPalette = { obstacle: [7, 8, 9], floor: [10, 11, 12] };

const SCENE = {
  sceneId: "yard",
  overlayUrl: "/scenes/yard.overlay.json",
  metadataUrl: "/scenes/yard.meta.json",
  pointCloudUrl: "/scenes/yard.pcd",
};

const backdropFor = (label: string) => ({
  dataUrl: `data:image/png;base64,${label}`,
  width: 2,
  height: 2,
  bounds: { minX: 0, maxX: 2, minY: 0, maxY: 2 },
  meta: {},
});

const toastMessages = (): string[] =>
  useNotifications().items.map((item) => item.message);

const mountOverlay = (
  initialScene: Record<string, unknown> | null = SCENE,
  initialPalette: PointCloudPalette = DARK,
) => {
  const scene = ref(initialScene);
  const palette = ref(initialPalette);
  let api: ReturnType<typeof useSceneOverlay> | null = null;

  const Harness = defineComponent({
    setup() {
      api = useSceneOverlay(
        () => scene.value,
        () => palette.value,
      );
      return () => h("div");
    },
  });

  const wrapper = mount(Harness);
  return { wrapper, api: api!, scene, palette };
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetNotifications();
  backdropMock.mockReset();
  backdropMock.mockResolvedValue(backdropFor("stub"));
  fetchMock = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(
      new Response(JSON.stringify({ url: String(input) }), { status: 200 }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the lanelet overlay and the metadata document", () => {
  it("exposes both once they arrive", async () => {
    const { api } = mountOverlay();
    await flushPromises();

    expect(api.overlay.value).toMatchObject({ url: SCENE.overlayUrl });
    expect(api.metadata.value).toMatchObject({ url: SCENE.metadataUrl });
  });

  it("degrades to no lanelets, with a toast, when the overlay fails", async () => {
    // The map is still useful without lane lines, so this is a warning rather than
    // an error state — but it must not be silent either.
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const { api } = mountOverlay();
    await flushPromises();

    expect(api.overlay.value).toBeNull();
    expect(toastMessages()).toContain(
      "路网覆盖层加载失败，地图将不显示车道线。",
    );
  });

  it("says so when the metadata cannot be read, because positioning depends on it", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    const { api } = mountOverlay();
    await flushPromises();

    expect(api.metadata.value).toBeNull();
    expect(toastMessages()).toContain(
      "场景元数据加载失败，地图可能无法正确定位。",
    );
  });

  it("asks for nothing when the scene declares no assets", async () => {
    const { api } = mountOverlay({ sceneId: "bare" });
    await flushPromises();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(api.overlay.value).toBeNull();
    expect(api.pointCloudBackdrop.value).toBeNull();
  });
});

describe("the point-cloud backdrop", () => {
  it("loads it with the palette it was given", async () => {
    const { api } = mountOverlay();
    await flushPromises();

    expect(backdropMock).toHaveBeenCalledWith(
      expect.objectContaining({ sceneId: "yard" }),
      DARK,
    );
    expect(api.pointCloudBackdrop.value?.dataUrl).toContain("stub");
  });

  it("re-rasterizes when the theme changes", async () => {
    // The colours are baked into a PNG, so a theme switch cannot be a CSS matter —
    // it has to produce a new image. This is the watch that makes it happen.
    const { palette, wrapper } = mountOverlay();
    await flushPromises();
    backdropMock.mockClear();

    palette.value = LIGHT;
    await wrapper.vm.$nextTick();
    await flushPromises();

    expect(backdropMock).toHaveBeenCalledWith(expect.anything(), LIGHT);
  });

  it("reports a failure in the map rather than as a toast", async () => {
    // The backdrop *is* what the operator is looking at, so its absence belongs on
    // the map itself.
    backdropMock.mockRejectedValue(new Error("点云文件加载失败: HTTP 404"));
    const { api } = mountOverlay();
    await flushPromises();

    expect(api.pointCloudError.value).toContain("HTTP 404");
    expect(toastMessages()).toEqual([]);
  });

  it("cannot be overwritten by a slow load for a scene that was left", async () => {
    // Without the monotonic request id, switching scenes while the first cloud is
    // still rasterizing paints the old scene's backdrop under the new scene's
    // vehicles — and it looks like the map is simply wrong.
    let releaseFirst: (value: unknown) => void = () => undefined;
    backdropMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );
    backdropMock.mockResolvedValueOnce(backdropFor("second"));

    const { api, scene, wrapper } = mountOverlay();
    scene.value = {
      ...SCENE,
      sceneId: "dock",
      pointCloudUrl: "/scenes/dock.pcd",
    };
    await wrapper.vm.$nextTick();
    await flushPromises();

    expect(api.pointCloudBackdrop.value?.dataUrl).toContain("second");

    releaseFirst(backdropFor("first"));
    await flushPromises();

    expect(api.pointCloudBackdrop.value?.dataUrl).toContain("second");
  });

  it("drops a load that is still in flight when the map goes away", async () => {
    let release: (value: unknown) => void = () => undefined;
    backdropMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const { api, wrapper } = mountOverlay();
    wrapper.unmount();
    release(backdropFor("late"));
    await flushPromises();

    expect(api.pointCloudBackdrop.value).toBeNull();
  });
});
