/**
 * `messageFor` factory shared by the admin config views.
 *
 * Every admin editor (用户 / 角色 / 用户组 / 车辆 / 编队 / 场景 / 定时报表 / 外发 / 消息规则) maps a
 * backend error code to a Chinese sentence the same way: the code arrives as the thrown Error's
 * `message` (fleetApi's convention — a non-2xx response rejects with the stable error code as the
 * message), and an unknown code (or a non-Error value) falls back to a generic line. The maps
 * differ per view; only this plumbing was being copy-pasted, so it lives here.
 *
 * `config_not_applied` is shared by every config editor: the change validated but could not take
 * effect together with the rest of the configuration, and the backend rolled the file back. Its
 * `detail` is the actual reason, which the admin needs to fix the input — so it is shown verbatim.
 * `config_conflict` is the optimistic-concurrency refusal: someone else saved the file after this
 * editor loaded it and the two edits overlap (non-overlapping edits merge silently on the server),
 * and nothing was written — the admin must reload rather than retry.
 */
export const makeMessageFor =
  (map: Record<string, string>, fallback = "保存失败，请稍后重试") =>
  (error: unknown): string => {
    const code = error instanceof Error ? error.message : "";
    if (code === "config_conflict" && !map[code]) {
      return "保存未执行：你和他人在编辑期间改了同一项，请刷新页面查看最新内容后重新编辑";
    }
    if (code === "config_not_applied" && !map[code]) {
      const detail = (error as { detail?: unknown }).detail;
      return typeof detail === "string" && detail
        ? `保存未生效：${detail}`
        : "保存未生效，已回滚到修改前";
    }
    return map[code] ?? fallback;
  };
