import { describe, it, expect, beforeEach } from "vitest";
import { reactive, ref } from "vue";
import {
  DEVICE_LAYOUT_STORAGE_KEY,
  MAP_READABLE_LIMIT,
  MAP_SURFACE_STORAGE_KEY,
  useDeviceView,
  __resetDeviceView,
} from "@/composables/useDeviceView";

/**
 * The three-state layout preference, which exists so that looking at the list once
 * does not silently opt you out of ever getting the map back.
 */
beforeEach(() => {
  localStorage.clear();
  __resetDeviceView();
});

describe("choosing the layout automatically", () => {
  it("shows the map for a fleet a map can actually show", () => {
    const view = useDeviceView(ref(6));
    expect(view.layout.value).toBe("map");
    expect(view.layoutIsAutomatic.value).toBe(true);
  });

  it("falls back to the list once the map would be a cloud of markers", () => {
    expect(useDeviceView(ref(MAP_READABLE_LIMIT + 1)).layout.value).toBe(
      "list",
    );
  });

  it("treats the threshold itself as still readable", () => {
    expect(useDeviceView(ref(MAP_READABLE_LIMIT)).layout.value).toBe("map");
  });

  it("follows the fleet as it grows, while nobody has overridden it", () => {
    const count = ref(10);
    const view = useDeviceView(count);
    expect(view.layout.value).toBe("map");

    count.value = 200;
    expect(view.layout.value).toBe("list");
  });

  it("accepts a getter as well as a ref, because a store exposes computeds", () => {
    // The getter has to read reactive state — a getter over a plain local variable
    // is read once and never again, which is Vue's rule rather than this module's.
    const fleet = reactive({ size: 3 });
    const view = useDeviceView(() => fleet.size);
    expect(view.layout.value).toBe("map");

    fleet.size = 500;
    expect(view.layout.value).toBe("list");
  });
});

describe("an explicit choice", () => {
  it("outranks the threshold in both directions", () => {
    const count = ref(500);
    const view = useDeviceView(count);
    expect(view.layout.value).toBe("list");

    view.setLayout("map");
    expect(view.layout.value).toBe("map");
    expect(view.layoutIsAutomatic.value).toBe(false);

    count.value = 2;
    view.setLayout("list");
    expect(view.layout.value).toBe("list");
  });

  it("can be handed back to the threshold", () => {
    const view = useDeviceView(ref(2));
    view.setLayout("list");
    expect(view.layout.value).toBe("list");

    view.setLayout("auto");
    expect(view.layout.value).toBe("map");
  });

  it("survives a reload", () => {
    useDeviceView(ref(2)).setLayout("list");
    expect(localStorage.getItem(DEVICE_LAYOUT_STORAGE_KEY)).toBe("list");

    __resetDeviceView();
    expect(useDeviceView(ref(2)).layout.value).toBe("list");
  });

  it("ignores a stored value it does not recognise", () => {
    // Including v1.0.0's `gps`/`scene`, which belonged to the *surface* preference —
    // a value from the wrong concept must not decide the layout.
    localStorage.setItem(DEVICE_LAYOUT_STORAGE_KEY, "scene");
    __resetDeviceView();

    expect(useDeviceView(ref(2)).layoutPreference.value).toBe("auto");
  });
});

describe("the map surface", () => {
  it("starts on GPS and remembers a switch", () => {
    const view = useDeviceView(ref(2));
    expect(view.surface.value).toBe("gps");

    view.setSurface("scene");
    expect(localStorage.getItem(MAP_SURFACE_STORAGE_KEY)).toBe("scene");

    __resetDeviceView();
    expect(useDeviceView(ref(2)).surface.value).toBe("scene");
  });

  it("keeps v1.0.0's key, so the Phase 14 switchover does not reset it", () => {
    // The old frontend wrote this key on the origin the console will inherit.
    localStorage.setItem(MAP_SURFACE_STORAGE_KEY, "scene");
    __resetDeviceView();

    expect(useDeviceView(ref(2)).surface.value).toBe("scene");
  });

  it("is independent of the layout", () => {
    const view = useDeviceView(ref(2));
    view.setSurface("scene");
    view.setLayout("list");

    expect(view.surface.value).toBe("scene");
    expect(view.layout.value).toBe("list");
  });
});
