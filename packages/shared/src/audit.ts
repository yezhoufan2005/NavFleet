/**
 * The auditable actions. A closed **tuple** (not just a union) so it is the single
 * source of truth: `AuditAction` derives from it, the backend's `auditQuerySchema.action` builds
 * its `z.enum` from the same array, and the console's 审计 labels are typed
 * `Record<AuditAction, string>`. Before, the query enum and the labels were each kept by hand and
 * both drifted: actions that were recorded could not be filtered for, or had no 动作 label.
 *
 * Scoped to auth + user management + operator-domain config writes on purpose — a read-only
 * monitoring system gains nothing from auditing reads, and config *reload* has no actor (see
 * `configRegistry` logging).
 */
export const AUDIT_ACTIONS = [
  "login",
  "login_failed",
  "logout",
  "password_change",
  "password_reset",
  "user_create",
  "user_update",
  "user_delete",
  // Session management.
  "session_revoke",
  "force_logout",
  "account_locked",
  // Alert acknowledgement.
  "alert_ack",
  "alert_unack",
  // Report-code dictionary import.
  "codebook_import",
  // Outbound-notification config write.
  "notify_write",
  // Alert-rule config write.
  "rules_write",
  // Scheduled-report config write.
  "reports_write",
  // Device-onboarding wizard config writes.
  "vehicles_write",
  "formations_write",
  "scenes_write",
  "scene_asset_upload",
  // Custom roles + user groups.
  "role_create",
  "role_update",
  "role_delete",
  "group_create",
  "group_update",
  "group_delete",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
