/**
 * `messageFor` factory shared by the admin config views.
 *
 * Every admin editor (用户 / 角色 / 用户组 / 车辆 / 编队 / 场景 / 定时报表 / 外发 / 告警规则) maps a
 * backend error code to a Chinese sentence the same way: the code arrives as the thrown Error's
 * `message` (fleetApi's convention — a non-2xx response rejects with the stable error code as the
 * message), and an unknown code (or a non-Error value) falls back to a generic line. The maps
 * differ per view; only this plumbing was being copy-pasted, so it lives here.
 */
export const makeMessageFor =
  (map: Record<string, string>, fallback = "保存失败，请稍后重试") =>
  (error: unknown): string => {
    const code = error instanceof Error ? error.message : "";
    return map[code] ?? fallback;
  };
