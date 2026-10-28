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
 * Any other 4xx the view has no sentence for still shows the backend's `detail` (which names the
 * field or the reference at fault) instead of a generic failure line.
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
    // A schema-validated request lists its field problems; the first one is the sentence to show
    // (the schemas carry Chinese messages for the fields a person types into).
    const issues = (error as { issues?: unknown }).issues;
    if (
      code === "invalid_request" &&
      !map[code] &&
      Array.isArray(issues) &&
      issues.length
    ) {
      const first = issues[0] as { message?: unknown };
      if (typeof first.message === "string" && first.message)
        return first.message;
    }
    // The backend's sentence for a 4xx names the field or the reference at fault: appended to the
    // view's own wording for a validator refusal (invalid_*), shown alone for a refusal the view
    // has no sentence for (scene_in_use). Never for a 5xx, whose detail is internal.
    const detail = (error as { detail?: unknown }).detail;
    const status = (error as { status?: unknown }).status;
    const explained =
      typeof detail === "string" &&
      detail &&
      typeof status === "number" &&
      status < 500
        ? detail
        : null;
    const mapped = map[code];
    if (mapped) {
      return explained && code.startsWith("invalid_")
        ? `${mapped}：${explained}`
        : mapped;
    }
    return explained ? `保存失败：${explained}` : fallback;
  };
