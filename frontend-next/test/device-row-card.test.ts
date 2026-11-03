import { describe, it, expect, afterEach } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import type { DeviceAlert, DeviceSnapshot } from "@navfleet/shared";
import DeviceRowCard from "@/components/device/DeviceRowCard.vue";

/**
 * item 8: the expanded row-card's active-code pills. They must stack a device's codes
 * (not collapse to one), carry the dictionary fault name rather than the generic
 * 预警报码/告警报码 title, and read left-to-right worst-severity-first then newest-onset
 * first. This file owns that ordering and the headline choice; the pill styling lives
 * in the component.
 */
enableAutoUnmount(afterEach);

const alert = (over: Partial<DeviceAlert>): DeviceAlert => ({
  id: "a",
  title: "告警",
  detail: "",
  severity: "warning",
  source: "rule",
  ts: "2026-03-01T00:00:00.000Z",
  active: true,
  ...over,
});

const device = (alerts: DeviceAlert[]): DeviceSnapshot => ({
  deviceId: "agv-01",
  deviceName: "A01",
  topic: "t",
  online: true,
  stamp: "2026-03-01T00:00:00.000Z",
  sceneId: "s",
  runtimeSceneId: "s",
  defaultSceneId: "s",
  gpsEnabled: false,
  rosMapEnabled: true,
  tags: [],
  formationIds: [],
  gps: { lat: null, lng: null, heading: null },
  fusionLoc: { x: null, y: null, yaw: null },
  lidarLoc: { x: null, y: null, yaw: null },
  vehicleInfo: {
    controlMode: null,
    gear: null,
    speed: null,
    omega: null,
    soc: null,
  },
  taskStatus: null,
  platformTaskStatus: null,
  infoCode: { code: 0, info: "", stamp: null },
  warningCode: { code: 0, info: "", stamp: null },
  errorCode: { code: 0, info: "", stamp: null },
  speedLimit: { limit: null, slowdownTime: null, stamp: null, moduleName: "" },
  alerts,
  extra: {},
});

const mountCard = async (alerts: DeviceAlert[]) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/:rest(.*)*", component: { template: "<i />" } }],
  });
  await router.push("/");
  await router.isReady();
  const wrapper = mount(DeviceRowCard, {
    props: { device: device(alerts), formationNames: [] },
    global: { plugins: [router] },
  });
  await flushPromises();
  return wrapper;
};

/** The code pills are the bordered, rounded status spans; the "另有 N 条" note is not bordered. */
const pillTexts = (wrapper: Awaited<ReturnType<typeof mountCard>>) =>
  wrapper
    .findAll("span")
    .filter(
      (node) =>
        node.classes().includes("border") &&
        node.classes().includes("rounded-sm"),
    )
    .map((node) => node.text());

describe("DeviceRowCard active-code pills (item 8)", () => {
  it("orders pills by severity (worst first), then onset time (newest first)", async () => {
    const wrapper = await mountCard([
      alert({
        id: "w",
        severity: "warning",
        title: "预警一",
        firstSeenAt: "2026-03-01T05:00:00.000Z",
      }),
      alert({
        id: "c-old",
        severity: "critical",
        title: "告警旧",
        firstSeenAt: "2026-03-01T01:00:00.000Z",
      }),
      alert({
        id: "c-new",
        severity: "critical",
        title: "告警新",
        firstSeenAt: "2026-03-01T03:00:00.000Z",
      }),
    ]);
    // Two critical (newer, then older) ahead of the single warning, despite the warning's
    // later onset — severity dominates, time breaks ties within a severity.
    expect(pillTexts(wrapper)).toEqual(["告警新", "告警旧", "预警一"]);
  });

  it("shows the dictionary fault name for a code-sourced alert, not the generic title", async () => {
    const wrapper = await mountCard([
      alert({
        id: "wc",
        severity: "warning",
        source: "warning_code",
        title: "预警报码",
        detail: "电量偏低",
      }),
    ]);
    expect(pillTexts(wrapper)).toEqual(["电量偏低"]);
  });

  it("stacks up to three and notes the overflow", async () => {
    const wrapper = await mountCard(
      Array.from({ length: 5 }, (_unused, index) =>
        alert({
          id: `c${index}`,
          severity: "critical",
          title: `告警 ${index}`,
          firstSeenAt: `2026-03-01T0${index}:00:00.000Z`,
        }),
      ),
    );
    expect(pillTexts(wrapper)).toHaveLength(3);
    expect(wrapper.text()).toContain("另有 2 条");
  });
});
