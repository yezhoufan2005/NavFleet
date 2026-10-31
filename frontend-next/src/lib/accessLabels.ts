import type { Capability, UserRole } from "@navfleet/shared";

/** The three built-in roles, as 用户 / the session menu / 审计 name them. */
export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "管理员",
  operator: "操作员",
  viewer: "只读",
};

/** Chinese labels for the capability catalog, in `CAPABILITIES` order (角色 and 审计 both use it). */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  "alerts:ack": "确认告警",
  "vehicles:write": "车辆配置",
  "formations:write": "编队配置",
  "scenes:write": "场景配置",
  "codebook:write": "报码字典",
  "notify:read": "外发记录",
  "notify:write": "外发配置",
  "rules:write": "消息规则",
  "reports:write": "定时报表",
  "audit:read": "审计日志",
  "users:manage": "用户管理",
  "debug:ingest": "调试注入",
};
