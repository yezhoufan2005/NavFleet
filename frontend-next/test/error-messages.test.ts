import { describe, it, expect } from "vitest";
import { ApiError } from "@navfleet/fleet-core";
import { loadErrorMessage, makeMessageFor } from "@/lib/errorMessages";

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
      "改了同一项",
    );
  });

  it("shows the backend's explanation for an unmapped 4xx, but never a 5xx's internals", () => {
    expect(
      messageFor(
        new ApiError("scene_in_use", 409, "场景仍被引用：车辆 agv-1（yard）"),
      ),
    ).toBe("保存失败：场景仍被引用：车辆 agv-1（yard）");
    expect(messageFor(new ApiError("internal_error", 500, "stack trace"))).toBe(
      "保存失败，请稍后重试",
    );
  });

  it("appends the validator's detail to a mapped invalid_* code", () => {
    const forScenes = makeMessageFor({ invalid_scenes: "场景配置不合法" });
    expect(
      forScenes(
        new ApiError(
          "invalid_scenes",
          400,
          "scenes[0].width must be a whole number of pixels",
        ),
      ),
    ).toBe("场景配置不合法：scenes[0].width must be a whole number of pixels");
  });

  it("shows the first field problem of a schema-validated request", () => {
    expect(
      messageFor(
        new ApiError("invalid_request", 400, null, [
          { path: "email", message: "邮箱格式不正确" },
        ]),
      ),
    ).toBe("邮箱格式不正确");
  });
});

describe("loadErrorMessage", () => {
  it("never shows the backend's code, and gives a refused query its own reason", () => {
    expect(
      loadErrorMessage(new ApiError("internal_error", 500), "消息历史加载失败"),
    ).toBe("消息历史加载失败");
    expect(loadErrorMessage(new ApiError("too_many_requests", 429), "x")).toBe(
      "请求过于频繁，请稍后再试",
    );
    expect(
      loadErrorMessage(
        new ApiError("invalid_request", 400, null, [
          { path: "from", message: "时间范围不能超过 366 天" },
        ]),
        "可用率报表加载失败",
      ),
    ).toBe("时间范围不能超过 366 天");
    expect(loadErrorMessage(new Error("HTTP 502"), "历史数据加载失败")).toBe(
      "历史数据加载失败",
    );
  });
});

describe("makeMessageFor — refusals the view does not name", () => {
  it("explains a 403 instead of calling it a passing failure", () => {
    expect(makeMessageFor({})(new ApiError("forbidden", 403))).toBe(
      "当前账号没有这项操作的权限",
    );
  });
});
