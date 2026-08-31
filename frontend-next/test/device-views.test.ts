import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { fleetApi, formatStamp } from "@navfleet/fleet-core";
import DevicesView from "@/views/DevicesView.vue";
import SceneMap from "@/components/map/SceneMap.vue";
import GpsMap from "@/components/map/GpsMap.vue";
import { useFleetStore } from "@/stores/fleet";
import {
  MAP_READABLE_LIMIT,
  __resetDeviceView,
} from "@/composables/useDeviceView";
import { __resetTheme } from "@/composables/useTheme";
import { usePointCloudPalette } from "@/composables/usePointCloudPalette";

/**
 * The devices page and the two maps it hosts.
 *
 * The first case is the most valuable one in this file: the Playwright suite proves
 * "the map opened on the selected vehicle" by measuring the screen box of
 * `.map-surface svg .ros-marker.fusion .ros-marker-core`. That selector is a contract
 * between a component and a spec in another workspace, and nothing but a test says so.
 */
enableAutoUnmount(afterEach);

const device = (patch: Record<string, unknown> = {}) => ({
  deviceId: "agv-01",
  deviceName: "AGV 01",
  online: true,
  sceneId: "yard",
  fusion_loc: { x: 10, y: 20, yaw: 0 },
  gps: { lat: 31.2, lng: 121.4 },
  ...patch,
});

const SCENE = {
  sceneId: "yard",
  sceneName: "北区堆场",
  resolution: 1,
  origin: { x: 0, y: 0, yaw: 0 },
  width: 100,
  height: 60,
};

const PANEL = {
  width: 800,
  height: 600,
  top: 0,
  left: 0,
  right: 800,
  bottom: 600,
  x: 0,
  y: 0,
  toJSON: () => ({}),
};

let store: ReturnType<typeof useFleetStore>;

const seed = (count = 1) => {
  store.ingestPayload(
    {
      fleetName: "示范车队",
      topicPattern: "/fleet/{deviceId}/vehicle_info",
      devices: Array.from({ length: count }, (_unused, index) =>
        device({
          deviceId: `agv-${String(index + 1).padStart(2, "0")}`,
          deviceName: `AGV ${index + 1}`,
        }),
      ),
    },
    "api",
  );
};

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  __resetDeviceView();
  __resetTheme();
  vi.spyOn(fleetApi, "getScenes").mockResolvedValue({ items: [] });
  vi.spyOn(fleetApi, "getScene").mockRejectedValue(new Error("no scene"));
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(PANEL);
  store = useFleetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the marker contract the e2e suite measures", () => {
  it("puts a core shape inside .ros-marker.fusion, centred on the pose", async () => {
    const wrapper = mount(SceneMap, {
      props: {
        selectedDevice: {
          deviceId: "agv-01",
          fusionLoc: { x: 10, y: 20, yaw: 0 },
        } as never,
        sceneDefinition: SCENE,
        sceneDevices: [],
        trails: {},
      },
    });
    await flushPromises();

    const marker = wrapper.find(".ros-marker.fusion");
    expect(marker.exists()).toBe(true);
    // Centred on 0,0 inside the pose-translated group: the spec reads this shape's
    // box, so an offset here would silently move what it measures.
    const core = marker.find(".ros-marker-core");
    expect(core.exists()).toBe(true);
    expect(core.attributes("cx") ?? "0").toBe("0");
    expect(marker.attributes("transform")).toContain("translate(10 20)");
  });

  it("labels the surface so the spec can find it by role", async () => {
    const wrapper = mount(SceneMap, {
      props: {
        selectedDevice: null,
        sceneDefinition: SCENE,
        sceneDevices: [],
        trails: {},
      },
    });
    await flushPromises();

    expect(wrapper.find("svg[aria-label='ROS 场景地图']").exists()).toBe(true);
  });

  it("draws a peer marker per other vehicle in the scene", async () => {
    const wrapper = mount(SceneMap, {
      props: {
        selectedDevice: {
          deviceId: "agv-01",
          fusionLoc: { x: 5, y: 5 },
        } as never,
        sceneDefinition: SCENE,
        sceneDevices: [
          { deviceId: "agv-01", fusionLoc: { x: 5, y: 5 } },
          {
            deviceId: "agv-02",
            deviceName: "AGV 2",
            fusionLoc: { x: 30, y: 30 },
          },
        ] as never,
        trails: {},
      },
    });
    await flushPromises();

    expect(wrapper.findAll(".ros-secondary-marker")).toHaveLength(1);
  });

  it("says the scene is unusable rather than drawing an empty grid", async () => {
    const wrapper = mount(SceneMap, {
      props: {
        selectedDevice: null,
        sceneDefinition: null,
        sceneDevices: [],
        trails: {},
      },
    });
    await flushPromises();

    expect(wrapper.text()).toContain("暂无可用地图");
  });
});

describe("what else the scene map draws", () => {
  const mountScene = async (props: Record<string, unknown> = {}) => {
    const wrapper = mount(SceneMap, {
      props: {
        selectedDevice: {
          deviceId: "agv-01",
          fusionLoc: { x: 10, y: 20, yaw: 0 },
          lidarLoc: { x: 12, y: 22, yaw: 0.5 },
        },
        sceneDefinition: SCENE,
        sceneDevices: [],
        trails: {},
        ...props,
      } as never,
      attachTo: document.body,
    });
    await flushPromises();
    return wrapper;
  };

  it("draws both fixes and the line between them", async () => {
    // Two independent position sources, and the gap between them is the information:
    // a large one means the fusion and the lidar disagree about where the vehicle is.
    const wrapper = await mountScene();

    expect(wrapper.find(".ros-marker.fusion").exists()).toBe(true);
    expect(wrapper.find(".ros-marker.lidar").exists()).toBe(true);
    expect(wrapper.find(".ros-link-line").exists()).toBe(true);
  });

  it("draws a trail per device that has one", async () => {
    const wrapper = await mountScene({
      sceneDevices: [
        { deviceId: "agv-01", fusionLoc: { x: 10, y: 20 } },
        { deviceId: "agv-02", fusionLoc: { x: 40, y: 30 } },
      ],
      trails: {
        "agv-01": [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ],
        "agv-02": [
          { x: 5, y: 5 },
          { x: 6, y: 6 },
        ],
      },
    });

    expect(wrapper.find(".device-trail.selected").exists()).toBe(true);
    expect(wrapper.findAll(".device-trail.peer")).toHaveLength(1);
  });

  it("puts an image-backed scene under the markers", async () => {
    const wrapper = await mountScene({
      sceneDefinition: { ...SCENE, imageUrl: "/scenes/yard.png" },
    });

    expect(wrapper.find("image").attributes("href")).toBe("/scenes/yard.png");
  });

  it("says so when the raster backdrop cannot be loaded", async () => {
    // The browser fetches this one, so the only signal is an `error` event on the
    // element — without handling it the operator gets a silently broken image while
    // the point-cloud path beside it reports failures properly.
    const wrapper = await mountScene({
      sceneDefinition: { ...SCENE, imageUrl: "/scenes/missing.png" },
    });
    expect(wrapper.text()).not.toContain("底图加载失败");

    await wrapper.find("image").trigger("error");

    expect(wrapper.text()).toContain("底图加载失败");
  });

  it("clears the backdrop failure when another scene is shown", async () => {
    // Keyed by href rather than by a boolean, so this needs no reset of its own —
    // and a stale "failed" notice over a perfectly good map is its own defect.
    const wrapper = await mountScene({
      sceneDefinition: { ...SCENE, imageUrl: "/scenes/missing.png" },
    });
    await wrapper.find("image").trigger("error");
    expect(wrapper.text()).toContain("底图加载失败");

    await wrapper.setProps({
      sceneDefinition: { ...SCENE, imageUrl: "/scenes/yard.png" },
    } as never);
    await flushPromises();

    expect(wrapper.text()).not.toContain("底图加载失败");
  });

  it("breaks a trail at a bad sample instead of drawing across the gap", async () => {
    // Dropping the point and joining the rest paints a straight line the vehicle
    // never drove — in a monitoring map that is a fabricated route, not a cosmetic
    // glitch. A gap has to read as a gap, so the sub-path restarts with `M`.
    const wrapper = await mountScene({
      sceneDevices: [{ deviceId: "agv-01", fusionLoc: { x: 10, y: 20 } }],
      trails: {
        "agv-01": [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
          { x: Number.NaN, y: 3 },
          { x: 4, y: 4 },
        ],
      },
    });

    const path = wrapper.find(".device-trail.selected").attributes("d") ?? "";
    expect(path.match(/M/g)).toHaveLength(2);
    expect(path).toBe("M 1 1 L 2 2 M 4 4");
  });

  it("still starts the path with a moveto when the first sample is the bad one", async () => {
    // The old implementation keyed `M` off the array index, so a dropped first point
    // left the path starting with `L` — which is not a valid path at all.
    const wrapper = await mountScene({
      sceneDevices: [{ deviceId: "agv-01", fusionLoc: { x: 10, y: 20 } }],
      trails: {
        "agv-01": [
          { x: Number.NaN, y: Number.NaN },
          { x: 2, y: 2 },
          { x: 3, y: 3 },
        ],
      },
    });

    expect(wrapper.find(".device-trail.selected").attributes("d")).toBe(
      "M 2 2 L 3 3",
    );
  });

  it("responds to the two view controls", async () => {
    // The map already opens focused on the vehicle, so 适应场景 is the one that moves
    // first — and 定位车辆 has to bring it back.
    const wrapper = await mountScene();
    const zoom = () => wrapper.text().match(/缩放\s*([\d.]+)x/)?.[1];
    const focused = zoom();

    const buttons = wrapper.findAll("button");
    await buttons
      .find((button) => button.text() === "适应场景")
      ?.trigger("click");
    expect(zoom()).not.toBe(focused);

    await buttons
      .find((button) => button.text() === "定位车辆")
      ?.trigger("click");
    expect(zoom()).toBe(focused);
  });

  it("wires the pointer and wheel handlers to the surface", async () => {
    // The handlers themselves are covered in `scene-viewport.test.ts`; what this
    // proves is that the template actually binds them. Events are constructed rather
    // than passed as trigger options because `clientX` is read-only on a real event.
    const wrapper = await mountScene();
    const svg = wrapper.find("svg").element;
    const zoom = () => wrapper.text().match(/缩放\s*([\d.]+)x/)?.[1];
    const before = zoom();

    svg.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, clientX: 400, clientY: 300 }),
    );
    await flushPromises();
    expect(zoom()).not.toBe(before);

    svg.dispatchEvent(
      new MouseEvent("pointerdown", { button: 0, clientX: 100, clientY: 100 }),
    );
    await flushPromises();
    expect(wrapper.find("svg").classes()).toContain("cursor-grabbing");

    svg.dispatchEvent(
      new MouseEvent("pointerup", { clientX: 100, clientY: 100 }),
    );
    await flushPromises();
    expect(wrapper.find("svg").classes()).toContain("cursor-grab");
  });

  it("names the scene it is showing", async () => {
    const wrapper = await mountScene();
    expect(wrapper.text()).toContain("北区堆场");
  });

  it("reports a failed backdrop on the map, not in a toast", async () => {
    // The backdrop is what the operator is looking at; a toast about it scrolls away
    // while the missing thing stays missing.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    );
    const wrapper = await mountScene({
      sceneDefinition: { ...SCENE, pointCloudUrl: "/scenes/yard.pcd" },
    });
    await flushPromises();

    expect(wrapper.text()).toContain("点云背景加载失败");
    expect(wrapper.text()).toContain("点云背景");
    vi.unstubAllGlobals();
  });

  it("skips a peer that has no position yet", async () => {
    const wrapper = await mountScene({
      sceneDevices: [
        { deviceId: "agv-01", fusionLoc: { x: 10, y: 20 } },
        { deviceId: "agv-02", deviceName: "AGV 2" },
      ],
    });

    expect(wrapper.findAll(".ros-secondary-marker")).toHaveLength(0);
  });

  it("draws a vehicle that only has a lidar fix", async () => {
    const wrapper = await mountScene({
      selectedDevice: { deviceId: "agv-01", lidarLoc: { x: 30, y: 30 } },
    });

    expect(wrapper.find(".ros-marker.lidar").exists()).toBe(true);
    expect(wrapper.find(".ros-marker.fusion").exists()).toBe(false);
    expect(wrapper.find(".ros-link-line").exists()).toBe(false);
  });
});

describe("the GPS map without credentials", () => {
  it("explains what to configure instead of showing an empty map", () => {
    // The common state on a fresh checkout: no `.env`. A blank grey map here is worse
    // than a sentence, and v1.0.0's sentence named the wrong project's file.
    const wrapper = mount(GpsMap, {
      props: { devices: [], selectedDeviceId: "" },
    });

    expect(wrapper.text()).toContain("等待 GPS 地图接入");
    expect(wrapper.text()).toContain("frontend-next/.env");
  });
});

describe("the GPS map against a fake SDK", () => {
  /**
   * AMap is a third-party script that cannot run here, so the SDK is faked. What that
   * buys is coverage of the parts with judgement in them: which vehicles get markers,
   * when the fleet is framed, and what counts as a reason to redraw.
   */
  interface FakeMarker {
    position: [number, number];
    zIndex: number;
    contents: number;
    setPosition: (position: [number, number]) => void;
    setContent: (content: HTMLElement) => void;
    setzIndex: (index: number) => void;
    on: (event: "click", handler: () => void) => void;
    click: () => void;
  }

  const markers: FakeMarker[] = [];
  const calls = { fitView: 0, zoomAndCenter: 0, style: [] as string[] };

  const fakeAmap = () => {
    markers.length = 0;
    calls.fitView = 0;
    calls.zoomAndCenter = 0;
    calls.style = [];

    return {
      Map: class {
        setMapStyle = (style: string): void => {
          calls.style.push(style);
        };
        setZoomAndCenter = (): void => {
          calls.zoomAndCenter += 1;
        };
        setFitView = (): void => {
          calls.fitView += 1;
        };
        getZoom = (): number => 12;
        add = (): void => undefined;
        remove = (marker: FakeMarker): void => {
          const index = markers.indexOf(marker);
          if (index >= 0) markers.splice(index, 1);
        };
        addControl = (): void => undefined;
        destroy = (): void => undefined;
      },
      Marker: class {
        position: [number, number];
        zIndex: number;
        contents = 1;
        private handler: (() => void) | null = null;

        constructor(options: { position: [number, number]; zIndex: number }) {
          this.position = options.position;
          this.zIndex = options.zIndex;
          markers.push(this as unknown as FakeMarker);
        }
        setPosition = (position: [number, number]): void => {
          this.position = position;
        };
        setContent = (): void => {
          this.contents += 1;
        };
        setzIndex = (index: number): void => {
          this.zIndex = index;
        };
        on = (_event: "click", handler: () => void): void => {
          this.handler = handler;
        };
        click = (): void => this.handler?.();
      },
      Scale: class {},
      ToolBar: class {},
    };
  };

  const mountMap = async (props: {
    devices: unknown[];
    selectedDeviceId: string;
  }) => {
    const amap = await import("@/lib/amap");
    vi.spyOn(amap, "hasAmapConfig").mockReturnValue(true);
    vi.spyOn(amap, "loadAmap").mockResolvedValue(fakeAmap());

    const wrapper = mount(GpsMap, { props: props as never });
    await flushPromises();
    return wrapper;
  };

  const gpsDevice = (id: string, lat: number, lng: number) => ({
    deviceId: id,
    deviceName: id.toUpperCase(),
    online: true,
    gps: { lat, lng, heading: 90 },
  });

  it("draws one marker per vehicle that reports a fix", async () => {
    await mountMap({
      devices: [
        gpsDevice("agv-01", 31.2, 121.4),
        gpsDevice("agv-02", 31.3, 121.5),
        // No fix: it belongs in the list, not on the map.
        { deviceId: "agv-03", deviceName: "AGV 03", online: true },
      ],
      selectedDeviceId: "agv-01",
    });

    expect(markers).toHaveLength(2);
  });

  it("frames the fleet once, and does not yank the view on later updates", async () => {
    // The demo fleet has a vehicle that goes offline and back, and re-fitting on every
    // device-set change pulled the map away from wherever the operator had panned it.
    const wrapper = await mountMap({
      devices: [
        gpsDevice("agv-01", 31.2, 121.4),
        gpsDevice("agv-02", 31.3, 121.5),
      ],
      selectedDeviceId: "agv-01",
    });
    expect(calls.fitView).toBe(1);

    await wrapper.setProps({
      devices: [
        gpsDevice("agv-01", 31.25, 121.45),
        gpsDevice("agv-02", 31.3, 121.5),
      ],
    } as never);
    await flushPromises();

    expect(calls.fitView).toBe(1);
  });

  it("redraws a marker only when something it shows has changed", async () => {
    // The watcher used to be `{ deep: true }` over the device array, so a tick that
    // moved nothing but the state of charge redrew every marker.
    const wrapper = await mountMap({
      devices: [gpsDevice("agv-01", 31.2, 121.4)],
      selectedDeviceId: "agv-01",
    });
    const drawnOnce = markers[0]?.contents;

    await wrapper.setProps({
      devices: [{ ...gpsDevice("agv-01", 31.2, 121.4), soc: 42 }],
    } as never);
    await flushPromises();

    expect(markers[0]?.contents).toBe(drawnOnce);
  });

  it("follows the theme, because the base map has its own styles", async () => {
    const { setPreference } = await import("@/composables/useTheme").then(
      (module) => module.useTheme(),
    );
    await mountMap({
      devices: [gpsDevice("agv-01", 31.2, 121.4)],
      selectedDeviceId: "agv-01",
    });

    setPreference("dark");
    await flushPromises();
    expect(calls.style.at(-1)).toContain("darkblue");
  });

  it("reports the selection when a marker is clicked", async () => {
    const wrapper = await mountMap({
      devices: [gpsDevice("agv-01", 31.2, 121.4)],
      selectedDeviceId: "",
    });

    markers[0]?.click();
    expect(wrapper.emitted("select")?.[0]).toEqual(["agv-01"]);
  });

  it("takes a vehicle off the map when it stops reporting a fix", async () => {
    const wrapper = await mountMap({
      devices: [
        gpsDevice("agv-01", 31.2, 121.4),
        gpsDevice("agv-02", 31.3, 121.5),
      ],
      selectedDeviceId: "agv-01",
    });
    expect(markers).toHaveLength(2);

    await wrapper.setProps({
      devices: [gpsDevice("agv-01", 31.2, 121.4)],
    } as never);
    await flushPromises();

    expect(markers).toHaveLength(1);
  });

  it("draws a vehicle that reports no heading", async () => {
    // Plenty of fixes have a position and no bearing; the marker is still the point.
    await mountMap({
      devices: [
        {
          deviceId: "agv-01",
          deviceName: "AGV 01",
          online: true,
          gps: { lat: 31.2, lng: 121.4 },
        },
      ],
      selectedDeviceId: "agv-01",
    });

    expect(markers).toHaveLength(1);
  });
});

describe("the devices page", () => {
  /**
   * With a router, because the list now links to each vehicle's detail page rather than
   * only moving the map's selection — see the note in `DevicesView.vue`. Without one,
   * `RouterLink` throws from inside its own resolve.
   */
  const mountPage = async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/:rest(.*)*", component: { template: "<i />" } }],
    });
    await router.push("/devices");
    await router.isReady();
    const wrapper = mount(DevicesView, {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    await flushPromises();
    return wrapper;
  };

  it("opens on the map for a fleet a map can show", async () => {
    seed(3);
    const wrapper = await mountPage();

    expect(wrapper.find(".map-surface").exists()).toBe(true);
    expect(wrapper.text()).toContain("按车队规模自动选择");
  });

  it("opens on the list once the fleet outgrows the map", async () => {
    seed(MAP_READABLE_LIMIT + 1);
    const wrapper = await mountPage();

    expect(wrapper.find(".map-surface").exists()).toBe(false);
    expect(wrapper.find("table").exists()).toBe(true);
  });

  it("switches on request, and stops calling itself automatic", async () => {
    seed(3);
    const wrapper = await mountPage();

    // Scoped to the 视图 group. The old form — the first `aria-pressed="false"`
    // button on the page — silently started hitting the 底图 toggle when that group
    // moved ahead of this one, and then asserted nothing.
    await wrapper
      .get("[aria-label='视图']")
      .findAll("button")
      .find((button) => button.text() === "列表")!
      .trigger("click");
    await flushPromises();

    expect(wrapper.text()).not.toContain("按车队规模自动选择");
  });

  it("puts the appearing group before the permanent one, so buttons stay put", async () => {
    // `PageHeader` right-anchors the actions, so a group that appears on the *right*
    // pushes 视图 sideways every time you switch to the map — the control moves out
    // from under the pointer. Ordering it first is what keeps 视图 anchored.
    seed(3);
    const wrapper = await mountPage();
    const groups = wrapper
      .findAll("[role='group']")
      .map((group) => group.attributes("aria-label"));

    expect(groups).toEqual(["底图", "视图"]);
  });

  it("opens the selected vehicle from the map's own list", async () => {
    // The map panel's rows select rather than navigate — that is their job, the map has
    // to be told what to centre on. But detail still has to be reachable from the map
    // (`frontend-ia.md`: from the list, the map or an alert), so the selection carries
    // one link.
    seed(3);
    const wrapper = await mountPage();
    const link = wrapper
      .findAll("aside a")
      .find((anchor) => anchor.text().includes("打开详情"));

    expect(link?.attributes("href")).toBe(
      `/devices/${store.state.selectedDeviceId}`,
    );
  });

  it("does not mark the first row as chosen when nobody chose it", async () => {
    // `ensureSelectedDevice` auto-selects the first vehicle on every ingest, because
    // the *map* needs a subject. Painting that in the list made row one come up
    // highlighted with nothing clicked — it read as "this row is special" when it only
    // meant "this is row one". Manual review reported it as a bug, correctly.
    seed(3);
    const wrapper = await mountPage();
    await wrapper
      .get("[aria-label='视图']")
      .findAll("button")
      .find((button) => button.text() === "列表")!
      .trigger("click");
    await flushPromises();

    // The store did select one — the list just does not claim it.
    expect(store.state.selectedDeviceId).toBe("agv-01");
    for (const row of wrapper.findAll("tbody tr")) {
      expect(row.classes()).not.toContain("bg-brand-wash");
    }
  });

  it("offers the surface toggle only while a map is showing", async () => {
    seed(3);
    const wrapper = await mountPage();
    expect(wrapper.find("[aria-label='底图']").exists()).toBe(true);

    const list = wrapper
      .findAll("button")
      .find((button) => button.text() === "列表");
    await list?.trigger("click");
    await flushPromises();

    expect(wrapper.find("[aria-label='底图']").exists()).toBe(false);
  });

  it("swaps the GPS surface for the scene surface", async () => {
    seed(3);
    const wrapper = await mountPage();
    expect(wrapper.findComponent(GpsMap).exists()).toBe(true);

    const scene = wrapper
      .findAll("button")
      .find((button) => button.text() === "场景");
    await scene?.trigger("click");
    await flushPromises();

    expect(wrapper.findComponent(SceneMap).exists()).toBe(true);
  });

  it("lists every device, and each row opens that vehicle", async () => {
    // The bug the manual review found: this cell used to be a button that only moved
    // the map's selection, so a healthy vehicle's detail page — and the four tabs on
    // it — could not be reached by clicking anything at all.
    seed(2);
    const wrapper = await mountPage();
    const list = wrapper
      .findAll("button")
      .find((button) => button.text() === "列表");
    await list?.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("AGV 1");
    expect(wrapper.text()).toContain("AGV 2");

    const second = wrapper
      .findAll("tbody a")
      .find((link) => link.text() === "AGV 2");
    expect(second?.attributes("href")).toBe("/devices/agv-02");

    await second?.trigger("click");
    await flushPromises();
    // Navigation is the point, and the selection still follows — so coming back to
    // the map lands on the vehicle you just looked at.
    expect(store.state.selectedDeviceId).toBe("agv-02");
  });

  it("distinguishes an empty fleet from one that has not arrived", async () => {
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain("暂无设备");

    store.state.realtime.bootstrapPending = true;
    await flushPromises();
    expect(wrapper.text()).toContain("正在加载车队…");
  });
});

describe("what the device list has to answer at a glance", () => {
  /** The list layout directly — the map is not the subject of any of these. */
  const mountList = async (patch: Record<string, unknown>[] = []) => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/:rest(.*)*", component: { template: "<i />" } }],
    });
    await router.push("/devices");
    await router.isReady();
    store.ingestPayload(
      {
        fleetName: "示范车队",
        topicPattern: "/fleet/{deviceId}/vehicle_info",
        devices: patch.map((item, index) =>
          device({
            deviceId: `agv-${String(index + 1).padStart(2, "0")}`,
            deviceName: `AGV ${index + 1}`,
            ...item,
          }),
        ),
      },
      "api",
    );
    const wrapper = mount(DevicesView, {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    await flushPromises();
    await wrapper
      .get("[aria-label='视图']")
      .findAll("button")
      .find((button) => button.text() === "列表")!
      .trigger("click");
    await flushPromises();
    return wrapper;
  };

  const headers = (wrapper: Awaited<ReturnType<typeof mountList>>) =>
    wrapper.findAll("thead th").map((cell) => cell.text());

  it("carries 最近上报 and 电量, the two columns the port dropped", async () => {
    // Without them "谁快没电了、谁的数据停了" takes one detail page per vehicle instead
    // of one glance — the single largest hit to shift-duty efficiency in the parity pass.
    const wrapper = await mountList([
      { vehicle_info: { soc: 82 }, stamp: "2026-08-30T02:00:00.000Z" },
    ]);

    expect(headers(wrapper)).toEqual([
      "状态",
      "设备",
      "编号",
      "场景",
      "最近上报",
      "电量",
    ]);
    const cells = wrapper.findAll("tbody td").map((cell) => cell.text());
    expect(cells).toContain("82%");
    expect(cells).toContain(formatStamp("2026-08-30T02:00:00.000Z"));
  });

  it("marks the rows that need attention, and fades the ones that are gone", async () => {
    // v1.0.0 tinted critical/warning rows and dropped offline ones to .74; the port kept
    // only the status dot. A dot answers "what state is this row in" once you are
    // already reading the row — the row treatment is what gets the answer to you before
    // you read anything, which is the entire job of a list you scan.
    const wrapper = await mountList([
      { error_code: { code: 5102, info: "" } },
      { warning_code: { code: 2301, info: "" } },
      { online: false },
      {},
    ]);

    const tones = wrapper
      .findAll("tbody tr")
      .map((row) => row.attributes("data-tone"));
    expect(tones).toContain("critical");
    expect(tones).toContain("warning");
    expect(tones).toContain("offline");
    expect(tones).toContain("normal");
    // Every row carries the hook the scoped rules key on, so none of them can be
    // silently left out of the treatment.
    for (const row of wrapper.findAll("tbody tr")) {
      expect(row.classes()).toContain("device-row");
      expect(row.attributes("data-tone")).toBeTruthy();
    }
  });

  it("says 未配置场景 instead of `--` for a device with no scene", async () => {
    const wrapper = await mountList([{ sceneId: "" }]);
    expect(wrapper.text()).toContain("未配置场景");
  });

  it("prefers the scene's name over its id once the definition is known", async () => {
    const wrapper = await mountList([{ sceneId: "yard" }]);
    expect(wrapper.findAll("tbody td").map((c) => c.text())).toContain("yard");

    store.state.sceneDefinitions.yard = SCENE as never;
    await flushPromises();

    expect(wrapper.findAll("tbody td").map((c) => c.text())).toContain(
      "北区堆场",
    );
  });
});

describe("the formation filter that was declared and never built", () => {
  /**
   * `sortedFormations` / `selectFormation` / `clearFormationSelection` were exported
   * from the store with zero callers, so `selectedFormationId` was permanently `""` and
   * `filteredDevices` was always the whole fleet. These pin the control that drives them.
   */
  const FORMATIONS = [
    {
      formationId: "f-north",
      formationName: "北区编队",
      deviceIds: ["agv-01", "agv-02"],
    },
    { formationId: "f-dock", formationName: "码头编队", deviceIds: ["agv-03"] },
  ];

  const mountWithFormations = async (query = "") => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/:rest(.*)*", component: { template: "<i />" } }],
    });
    await router.push(`/devices${query}`);
    await router.isReady();
    store.ingestPayload(
      {
        fleetName: "示范车队",
        topicPattern: "/fleet/{deviceId}/vehicle_info",
        formations: FORMATIONS,
        devices: [1, 2, 3].map((index) =>
          device({
            deviceId: `agv-0${index}`,
            deviceName: `AGV ${index}`,
            sceneId: index === 3 ? "dock" : "yard",
          }),
        ),
      } as never,
      "api",
    );
    const wrapper = mount(DevicesView, {
      attachTo: document.body,
      global: { plugins: [router] },
    });
    await flushPromises();
    return { wrapper, router };
  };

  const select = (wrapper: { find: (s: string) => unknown }) =>
    (wrapper as ReturnType<typeof mount>).get("select");

  it("offers one option per formation, plus 全部编队", async () => {
    const { wrapper } = await mountWithFormations();
    const options = select(wrapper)
      .findAll("option")
      .map((option) => option.text());

    expect(options[0]).toBe("全部编队");
    expect(options).toHaveLength(3);
    // Order comes from `sortedFormations` (by id), so assert the set rather than
    // restating that sort here — pinning it twice means changing it in two places.
    expect(options.slice(1).join(" ")).toContain("北区编队");
    expect(options.slice(1).join(" ")).toContain("码头编队");
    // The member count rides along, because "which formation" and "how big is it" get
    // asked together.
    expect(options.find((text) => text.includes("北区编队"))).toContain("2");
  });

  it("stays out of the way when no formation is configured", async () => {
    // An empty filter is worse than no filter — 总览 already says 未配置编队.
    seed(2);
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/:rest(.*)*", component: { template: "<i />" } }],
    });
    await router.push("/devices");
    await router.isReady();
    const wrapper = mount(DevicesView, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.find("select").exists()).toBe(false);
  });

  it("puts the choice in the URL rather than in a local ref", async () => {
    // 告警 already treats the query string as the source of truth for its filters, so a
    // pasted link reproduces the view. The same has to hold here.
    const { wrapper, router } = await mountWithFormations();

    await select(wrapper).setValue("f-north");
    await flushPromises();

    expect(router.currentRoute.value.query.formation).toBe("f-north");
    expect(store.state.selectedFormationId).toBe("f-north");
  });

  it("actually narrows the list, which is the whole point", async () => {
    const { wrapper } = await mountWithFormations();
    await select(wrapper).setValue("f-dock");
    await flushPromises();
    await wrapper
      .get("[aria-label='视图']")
      .findAll("button")
      .find((button) => button.text() === "列表")!
      .trigger("click");
    await flushPromises();

    const names = wrapper.findAll("tbody a").map((link) => link.text());
    expect(names).toEqual(["AGV 3"]);
  });

  it("arrives filtered from a deep link, even before the fleet does", async () => {
    // `selectFormation` ignores an id it does not know, and formations land with the
    // first snapshot — so the watcher has to depend on the formation count too, or a
    // pasted link is dropped on the floor in exactly the case it exists for.
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/:rest(.*)*", component: { template: "<i />" } }],
    });
    await router.push("/devices?formation=f-dock");
    await router.isReady();
    const wrapper = mount(DevicesView, { global: { plugins: [router] } });
    await flushPromises();
    expect(store.state.selectedFormationId).toBe("");

    store.ingestPayload(
      {
        fleetName: "示范车队",
        topicPattern: "/fleet/{deviceId}/vehicle_info",
        formations: FORMATIONS,
        devices: [device({ deviceId: "agv-03", sceneId: "dock" })],
      } as never,
      "api",
    );
    await flushPromises();

    expect(store.state.selectedFormationId).toBe("f-dock");
    wrapper.unmount();
  });

  it("clears back to the whole fleet through the store, not by blanking the id", async () => {
    const { wrapper, router } = await mountWithFormations();
    await select(wrapper).setValue("f-north");
    await flushPromises();

    await select(wrapper).setValue("");
    await flushPromises();

    expect(store.state.selectedFormationId).toBe("");
    expect(router.currentRoute.value.query.formation).toBeUndefined();
    expect(store.filteredDevices).toHaveLength(3);
  });

  it("keeps the GPS map on the whole fleet while the list narrows", async () => {
    // The asymmetry v1.0.0 had and the port flattened: the GPS map answers "where is the
    // fleet", so a filter must not make vehicles vanish from it — a half-empty site map
    // reads as "those vehicles are gone". `DashboardView.vue:303` passed the unfiltered
    // set for the same reason.
    const { wrapper } = await mountWithFormations();
    await select(wrapper).setValue("f-dock");
    await flushPromises();

    expect(store.filteredDevices).toHaveLength(1);
    expect(wrapper.findComponent(GpsMap).props("devices")).toHaveLength(3);
  });
});

describe("the point-cloud palette", () => {
  it("reads the tokens rather than hardcoding a pair", () => {
    document.documentElement.style.setProperty(
      "--color-ros-cloud-obstacle",
      "#010203",
    );
    document.documentElement.style.setProperty(
      "--ros-cloud-obstacle-alpha",
      "220",
    );

    const { palette } = usePointCloudPalette();
    expect(palette.value.obstacle).toEqual([1, 2, 3]);
    expect(palette.value.alpha?.obstacleMin).toBe(220);
  });

  it("falls back to v1.0.0's values when no stylesheet has loaded", () => {
    document.documentElement.style.removeProperty("--color-ros-cloud-obstacle");
    const { palette } = usePointCloudPalette();

    expect(palette.value.obstacle).toEqual([182, 237, 255]);
  });
});
