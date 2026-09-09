import { describe, expect, it } from "vitest";
import { config } from "../src/config";
import { historyQuerySchema } from "../src/validation";

/**
 * The history `limit` bound, pinned at the boundary.
 *
 * It used to accept up to 5000 while both query paths clamp to `MAX_HISTORY_POINTS`
 * (default 500) — and since `openapi.ts` generates the parameter *from this schema*,
 * the published contract promised 5000 for a server that never returns more than 500.
 *
 * The owner's call was to make the bound honest rather than to widen the
 * implementation, so the boundary is now a real edge and worth asserting on both
 * sides of. Note this is a **tightening**: a client that used to send `limit=5000`
 * and receive 500 rows now receives a 400.
 */
describe("history limit bound", () => {
  const cap = config.maxHistoryPoints;

  it("accepts the cap itself", () => {
    expect(historyQuerySchema.safeParse({ limit: String(cap) }).success).toBe(true);
  });

  it("rejects one past the cap rather than silently clamping", () => {
    // Rejecting is the point: clamping would answer a request for 501 with 500 rows
    // and no indication that the answer was not what was asked for.
    expect(historyQuerySchema.safeParse({ limit: String(cap + 1) }).success).toBe(false);
  });

  it("rejects the 5000 the spec used to promise", () => {
    expect(historyQuerySchema.safeParse({ limit: "5000" }).success).toBe(false);
  });

  it("still accepts a small explicit limit, and omitting it entirely", () => {
    expect(historyQuerySchema.safeParse({ limit: "1" }).success).toBe(true);
    expect(historyQuerySchema.safeParse({}).success).toBe(true);
  });

  it("still rejects zero and negatives", () => {
    expect(historyQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ limit: "-5" }).success).toBe(false);
  });
});
