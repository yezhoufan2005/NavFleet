import { z } from "zod";

/** A timestamp expressed as an ISO-8601 string or a numeric epoch (ms or s). */
const timestampString = z
  .string()
  .min(1)
  .refine(
    (value) => Number.isFinite(Date.parse(value)) || Number.isFinite(Number(value)),
    "must be an ISO-8601 datetime or a numeric epoch",
  );

export const historyQuerySchema = z.object({
  from: timestampString.optional(),
  to: timestampString.optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

export const alertsQuerySchema = z.object({
  severity: z.enum(["critical", "warning", "notice"]).optional(),
  deviceId: z.string().min(1).max(200).optional(),
  status: z.enum(["active", "cleared"]).optional(),
});

/**
 * Debug-ingest bodies are intentionally heterogeneous (the normalizer accepts
 * many shapes), so this only rejects primitives up front with a clean 400
 * instead of letting them fall through to a 500.
 */
export const ingestBodySchema = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]);

export type HistoryQueryInput = z.infer<typeof historyQuerySchema>;
export type AlertsQueryInput = z.infer<typeof alertsQuerySchema>;
