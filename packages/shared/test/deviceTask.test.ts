import { describe, it, expect } from "vitest";
import {
  formatTaskRoute,
  formatTaskStep,
  parseDeviceTask,
  type DeviceTask,
} from "../src/index";

const iso = (value: unknown): string | null =>
  typeof value === "number" ? new Date(value).toISOString() : null;

const STARTED = Date.UTC(2026, 10, 24, 2, 0, 0);

const task = (patch: Partial<DeviceTask> = {}): DeviceTask => ({
  id: "agv-01-20261124-0003",
  type: "搬运",
  from: "取货位 P03",
  to: "卸货位 D07",
  step: 2,
  steps: 4,
  stepName: "装货",
  startedAt: new Date(STARTED).toISOString(),
  ...patch,
});

describe("parseDeviceTask", () => {
  it("reads a snake_case frame task", () => {
    const parsed = parseDeviceTask(
      {
        task: {
          id: "agv-01-20261124-0003",
          type: "搬运",
          from: "取货位 P03",
          to: "卸货位 D07",
          step: 2,
          steps: 4,
          step_name: "装货",
          started_at: STARTED,
        },
      },
      null,
      iso,
    );
    expect(parsed).toEqual(task());
  });

  it("keeps the previous task when the frame says nothing, clears it on null", () => {
    const previous = task();
    expect(parseDeviceTask({}, previous, iso)).toBe(previous);
    expect(parseDeviceTask({ task: null }, previous, iso)).toBeNull();
    expect(
      parseDeviceTask({ task: { type: "搬运" } }, previous, iso),
    ).toBeNull();
  });

  it("reads an already-normalised snapshot and tolerates missing parts", () => {
    const parsed = parseDeviceTask(
      {
        task: {
          id: 7,
          stepName: "前往充电位",
          step: "1",
          steps: 1,
          startedAt: null,
        },
      },
      null,
      iso,
    );
    expect(parsed).toEqual({
      id: "7",
      type: "",
      from: null,
      to: null,
      step: 1,
      steps: 1,
      stepName: "前往充电位",
      startedAt: null,
    });
  });

  it("clamps a step past the total and drops a non-positive one", () => {
    expect(
      parseDeviceTask({ task: { id: "t", step: 5, steps: 4 } }, null, iso)
        ?.step,
    ).toBe(4);
    expect(
      parseDeviceTask({ task: { id: "t", step: 0, steps: 4 } }, null, iso)
        ?.step,
    ).toBeNull();
  });
});

describe("task formatting", () => {
  it("joins the route ends that exist", () => {
    expect(formatTaskRoute(task())).toBe("取货位 P03 → 卸货位 D07");
    expect(formatTaskRoute(task({ from: null }))).toBe("卸货位 D07");
    expect(formatTaskRoute(task({ from: null, to: null }))).toBe("");
  });

  it("states the step as N / M, with the step name", () => {
    expect(formatTaskStep(task())).toBe("第 2 / 4 步 · 装货");
    expect(formatTaskStep(task({ step: null }))).toBe("装货");
  });
});
