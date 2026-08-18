import { describe, it, expect } from "vitest";
import {
  controlModeMap,
  gearMap,
  taskStatusMap,
  formatEnum,
  describeEnum,
} from "../../src/utils/enums";

describe("formatEnum", () => {
  it("renders label with the raw code appended", () => {
    expect(formatEnum(1, controlModeMap)).toBe("自动驾驶 (1)");
    expect(formatEnum(2, taskStatusMap)).toBe("已完成 (2)");
    expect(formatEnum(-1, gearMap)).toBe("R (-1)");
  });

  it("returns -- for empty values", () => {
    expect(formatEnum(null, controlModeMap)).toBe("--");
    expect(formatEnum(undefined, gearMap)).toBe("--");
    expect(formatEnum("", taskStatusMap)).toBe("--");
  });

  it("falls back to the bare value for unknown codes", () => {
    expect(formatEnum(99, controlModeMap)).toBe("99");
  });
});

describe("describeEnum", () => {
  it("returns the description for a known code", () => {
    expect(describeEnum(1, controlModeMap)).toBe("车辆由控制器自动接管");
  });

  it("returns undefined for empty or unknown values", () => {
    expect(describeEnum(null, controlModeMap)).toBeUndefined();
    expect(describeEnum(99, controlModeMap)).toBeUndefined();
  });
});
