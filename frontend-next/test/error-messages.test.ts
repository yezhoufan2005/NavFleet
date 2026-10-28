import { describe, it, expect } from "vitest";
import { ApiError } from "@navfleet/fleet-core";
import { makeMessageFor } from "@/lib/errorMessages";

describe("makeMessageFor", () => {
  const messageFor = makeMessageFor({ conflict: "名称已存在" });

  it("maps a known code and falls back for an unknown one", () => {
    expect(messageFor(new ApiError("conflict", 409))).toBe("名称已存在");
    expect(messageFor(new Error("weird"))).toBe("保存失败，请稍后重试");
  });

  it("shows why a config change did not take effect, from the backend's detail", () => {
    const error = new ApiError(
      "config_not_applied",
      409,
      "scenes.json 保存后无法与现有配置一起生效，已回滚：osm missing",
    );
    expect(messageFor(error)).toBe(
      "保存未生效：scenes.json 保存后无法与现有配置一起生效，已回滚：osm missing",
    );
    expect(messageFor(new ApiError("config_not_applied", 409))).toBe(
      "保存未生效，已回滚到修改前",
    );
  });

  it("tells the admin to reload when someone else saved first", () => {
    expect(messageFor(new ApiError("config_conflict", 409))).toContain(
      "已被他人修改",
    );
  });
});
