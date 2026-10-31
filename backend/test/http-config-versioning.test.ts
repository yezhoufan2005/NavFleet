import { describe, it, expect } from "vitest";
import request from "supertest";
import { DEFAULT_ALERT_RULES, DEFAULT_REPORTS_CONFIG } from "@navfleet/shared";
import { createTestApp, sessionCookie, type TestAppContext } from "./helpers/testApp";
import { ConfigConflictError } from "../src/configRegistry";

/**
 * The optimistic-concurrency protocol, route by route. Every console-editable config file is read
 * with an ETag and written with If-Match; each route wires that up on its own, so one that forgets
 * `expectedConfigVersion` silently goes back to last-write-wins. Only `/vehicles` was pinned
 * before (http-deviceconfig.test.ts); this covers the rest.
 */
const ADMIN = sessionCookie("admin", "admin-1");

type WriteMock = keyof Pick<
  TestAppContext["store"],
  | "writeFormations"
  | "writeScenes"
  | "importCodebook"
  | "writeNotifyConfig"
  | "writeAlertRules"
  | "writeReportsConfig"
>;

const ROUTES: Array<{ name: string; read: string; write: string; body: unknown; mock: WriteMock }> =
  [
    {
      name: "formations",
      read: "/api/v1/formation-config",
      write: "/api/v1/formation-config",
      body: [],
      mock: "writeFormations",
    },
    {
      name: "scenes",
      read: "/api/v1/scenes",
      write: "/api/v1/scenes",
      body: [],
      mock: "writeScenes",
    },
    {
      name: "codebook",
      read: "/api/v1/codebook",
      write: "/api/v1/codebook",
      body: [],
      mock: "importCodebook",
    },
    {
      name: "notify",
      read: "/api/v1/notify/config/raw",
      write: "/api/v1/notify/config",
      body: { channels: [] },
      mock: "writeNotifyConfig",
    },
    {
      name: "rules",
      read: "/api/v1/rules/config",
      write: "/api/v1/rules/config",
      body: DEFAULT_ALERT_RULES,
      mock: "writeAlertRules",
    },
    {
      name: "reports",
      read: "/api/v1/reports/config",
      write: "/api/v1/reports/config",
      body: DEFAULT_REPORTS_CONFIG,
      mock: "writeReportsConfig",
    },
  ];

describe.each(ROUTES)("$name config — ETag / If-Match", ({ read, write, body, mock }) => {
  it("sends the version as an ETag and passes If-Match through to the write", async () => {
    const context = createTestApp();
    context.store.getConfigVersion.mockReturnValue("abc123");
    const got = await request(context.app).get(read).set("Cookie", ADMIN);
    expect(got.status).toBe(200);
    expect(got.headers.etag).toBe('"abc123"');

    const put = await request(context.app)
      .put(write)
      .set("Cookie", ADMIN)
      .set("If-Match", '"abc123"')
      .send(body as object);
    expect(put.status).toBe(200);
    expect(put.headers.etag).toBe('"abc123"');
    // The mocks are typed by their first argument only; the version is the second.
    const [call] = context.store[mock].mock.calls as unknown as Array<[unknown, string]>;
    expect(call?.[1]).toBe("abc123");
  });

  it("answers 409 config_conflict when the file changed since it was read", async () => {
    const context = createTestApp();
    context.store[mock].mockRejectedValue(new ConfigConflictError("x.json"));
    const response = await request(context.app)
      .put(write)
      .set("Cookie", ADMIN)
      .set("If-Match", '"stale"')
      .send(body as object);
    expect(response.status).toBe(409);
    expect((response.body as { error: string }).error).toBe("config_conflict");
    expect(context.auditService.record).not.toHaveBeenCalled();
  });
});
