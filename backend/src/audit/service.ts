import type { Persistence } from "../persistence";
import type { AuditAction, AuditEntry } from "../types";

/** Fields the caller supplies; `ts` is stamped here so every row is timed the same way. */
export interface AuditInput {
  actor: string;
  action: AuditAction;
  target?: string;
  outcome?: "success" | "failure";
  requestId?: string;
  detail?: Record<string, unknown>;
}

export interface AuditQuery {
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
}

/**
 * Records security-relevant actions (auth + user management) to the audit trail. Recording is
 * best-effort by construction — `Persistence.appendAudit` swallows write errors — so an emit
 * site never has to guard against audit failure breaking the action it is auditing.
 */
export class AuditService {
  constructor(private readonly persistence: Persistence) {}

  record(input: AuditInput): Promise<void> {
    const entry: AuditEntry = {
      ts: new Date(),
      actor: input.actor,
      action: input.action,
      outcome: input.outcome ?? "success",
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
    };
    return this.persistence.appendAudit(entry);
  }

  query(filters: AuditQuery): Promise<AuditEntry[]> {
    return this.persistence.queryAudit(filters);
  }
}
