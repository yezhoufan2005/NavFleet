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
/**
 * Sentences for the refusals any request can meet, whatever the view. A view's own map wins; these
 * fill in where it says nothing — before, a 403 on most editors read 「保存失败，请稍后重试」, as if
 * it were a passing fault, and three said 「需要管理员权限」 when what is needed is one capability.
 */
const COMMON_MESSAGES: Record<string, string> = {
  forbidden: "当前账号没有这项操作的权限",
  unauthorized: "登录已失效，请重新登录",
  too_many_requests: "请求过于频繁，请稍后再试",
};

/** The first schema issue of an `invalid_request` (the schemas carry Chinese messages), if any. */
const firstIssue = (error: unknown): string | null => {
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues) || !issues.length) return null;
  const first = issues[0] as { message?: unknown };
  return typeof first.message === "string" && first.message
    ? first.message
    : null;
};

/**
 * The sentence for a failed **read** (a list, a chart, a report). The thrown error's `message` is
 * the backend's code, and these panels used to render it as is — `internal_error`,
 * `too_many_requests`, `invalid_request` on a page meant for an operator. A refused query shows
 * its schema's reason (「时间范围不能超过 366 天」); anything else is `fallback`.
 */
export const loadErrorMessage = (error: unknown, fallback: string): string => {
  const code = error instanceof Error ? error.message : "";
  if (code === "invalid_request") return firstIssue(error) ?? fallback;
  return COMMON_MESSAGES[code] ?? fallback;
};

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
    if (code === "invalid_request" && !map[code]) {
      const issue = firstIssue(error);
      if (issue) return issue;
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
    const mapped = map[code] ?? COMMON_MESSAGES[code];
    if (mapped) {
      return explained && code.startsWith("invalid_")
        ? `${mapped}：${explained}`
        : mapped;
    }
    return explained ? `保存失败：${explained}` : fallback;
  };
