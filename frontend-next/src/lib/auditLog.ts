import type { AuditAction, Capability, UserRole } from "@navfleet/shared";
import type { AuditRecord } from "@navfleet/fleet-core";
import { CAPABILITY_LABELS, ROLE_LABELS } from "@/lib/accessLabels";

/**
 * Chinese labels for the closed action vocabulary. Typed against `AUDIT_ACTIONS`, so an action the
 * backend can record but this table does not name fails the build: the 动作 filter could not
 * select the role / group / three config-write actions before, and their rows showed the raw key.
 */
export const ACTION_LABELS: Record<AuditAction, string> = {
  login: "登录",
  login_failed: "登录失败",
  logout: "登出",
  password_change: "修改密码",
  password_reset: "重置密码",
  user_create: "创建用户",
  user_update: "更新用户",
  user_delete: "删除用户",
  session_revoke: "下线会话",
  force_logout: "强制下线",
  account_locked: "账号锁定",
  alert_ack: "确认告警",
  alert_unack: "取消确认",
  codebook_import: "导入报码字典",
  notify_write: "写入外发配置",
  rules_write: "写入消息规则",
  reports_write: "写入定时报表",
  vehicles_write: "写入车辆配置",
  formations_write: "写入编队配置",
  scenes_write: "写入场景配置",
  scene_asset_upload: "上传场景资源",
  role_create: "创建角色",
  role_update: "更新角色",
  role_delete: "删除角色",
  group_create: "创建用户组",
  group_update: "更新用户组",
  group_delete: "删除用户组",
};

/** A row's 动作 text; an action this build does not know (a newer backend) shows its key. */
export const actionLabel = (action: string): string =>
  ACTION_LABELS[action as AuditAction] ?? action;

const list = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const capabilities = (value: unknown): string =>
  list(value)
    .map((cap) => CAPABILITY_LABELS[cap as Capability] ?? cap)
    .join("、");

/** `label text`, or "" when there is no text. */
const labelled = (label: string, text: string): string =>
  text ? `${label} ${text}` : "";

const names = (value: unknown): string => list(value).join("、");

/** `+a、b −c`, or "" when nothing moved. */
const delta = (added: string, removed: string): string =>
  [added && `+${added}`, removed && `−${removed}`].filter(Boolean).join(" ");

const USER_FIELD_LABELS: Record<string, string> = {
  role: "角色",
  displayName: "显示名",
  email: "邮箱",
  phone: "电话",
  enabled: "启用",
};

const userValue = (key: string, value: unknown): string => {
  if (key === "enabled") return value ? "启用" : "停用";
  if (typeof value !== "string" || value === "") return "空";
  if (key === "role") return ROLE_LABELS[value as UserRole] ?? value;
  return value;
};

/** `角色 只读 → 操作员；邮箱已改` from a `user_update` detail. */
const userUpdateSummary = (detail: Record<string, unknown>): string => {
  const changes = (detail.changes ?? {}) as Record<
    string,
    { from?: unknown; to?: unknown }
  >;
  return list(detail.fields)
    .map((key) => {
      const label = USER_FIELD_LABELS[key] ?? key;
      const change = changes[key];
      return change
        ? `${label} ${userValue(key, change.from)} → ${userValue(key, change.to)}`
        : `${label}已改`;
    })
    .join("；");
};

/**
 * What the 对象 column shows: the name the detail carries (a role or group row's `target` is
 * its id), followed by what changed. Empty parts are dropped; a row with no detail shows its
 * target alone, as before.
 */
export const auditObject = (entry: AuditRecord): string => {
  const detail = entry.detail ?? {};
  const name = typeof detail.name === "string" ? detail.name : undefined;
  const parts: string[] = [name ?? entry.target ?? "—"];
  if (typeof detail.renamedFrom === "string")
    parts.push(`原名 ${detail.renamedFrom}`);
  switch (entry.action) {
    case "user_create":
      if (typeof detail.role === "string")
        parts.push(userValue("role", detail.role));
      break;
    case "user_update":
      parts.push(userUpdateSummary(detail));
      break;
    case "role_create":
      parts.push(labelled("能力", capabilities(detail.capabilities)));
      break;
    case "role_update":
      parts.push(
        labelled(
          "能力",
          delta(capabilities(detail.added), capabilities(detail.removed)),
        ),
      );
      break;
    case "group_create":
      parts.push(
        labelled("角色", names(detail.roles)),
        labelled("成员", names(detail.members)),
      );
      break;
    case "group_update":
      parts.push(
        labelled(
          "角色",
          delta(names(detail.rolesAdded), names(detail.rolesRemoved)),
        ),
        labelled(
          "成员",
          delta(names(detail.membersAdded), names(detail.membersRemoved)),
        ),
      );
      break;
  }
  return parts.filter(Boolean).join(" · ");
};
