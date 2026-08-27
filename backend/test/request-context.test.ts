import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp, sessionCookie } from "./helpers/testApp";
import { normalizeRequestId } from "../src/requestContext";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("normalizeRequestId", () => {
  it.each(["abc123", "req-1.2_3~4", "trace:00-ff", "a".repeat(128)])("accepts %s", (value) => {
    expect(normalizeRequestId(value)).toBe(value);
  });

  it.each([
    ["empty", ""],
    ["too long", "a".repeat(129)],
    ["CRLF log-forging attempt", 'ok\r\nlevel=30 msg="forged"'],
    ["newline", "ok\nmore"],
    ["space", "two words"],
    ["quote", 'id"'],
    ["duplicate headers arriving as an array", ["one", "two"]],
    ["absent", undefined],
    ["non-string", 42],
  ])("rejects %s", (_label, value) => {
    expect(normalizeRequestId(value)).toBeNull();
  });
});

describe("request correlation id", () => {
  it("mints an id and returns it on every response", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/health");

    expect(response.headers["x-request-id"]).toMatch(UUID_PATTERN);
  });

  it("gives different requests different ids", async () => {
    const { app } = createTestApp();
    const [first, second] = await Promise.all([
      request(app).get("/health"),
      request(app).get("/health"),
    ]);

    expect(first.headers["x-request-id"]).not.toBe(second.headers["x-request-id"]);
  });

  it("preserves a trustworthy upstream id so one id spans the hop chain", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/health").set("X-Request-Id", "edge-abc-123");

    expect(response.headers["x-request-id"]).toBe("edge-abc-123");
  });

  it("replaces an unsafe upstream id instead of echoing it into logs and headers", async () => {
    const { app } = createTestApp();
    // Node's HTTP client refuses to transmit CR/LF in a header value, so the
    // pure log-forging payload is covered by the normalizeRequestId table above.
    // This is the transmittable half: characters that would still end up in
    // every log line and in a response header if they were trusted.
    const response = await request(app).get("/health").set("X-Request-Id", 'stolen" msg="forged');

    expect(response.headers["x-request-id"]).toMatch(UUID_PATTERN);
  });

  it("replaces an over-long upstream id", async () => {
    const { app } = createTestApp();
    const response = await request(app).get("/health").set("X-Request-Id", "a".repeat(200));

    expect(response.headers["x-request-id"]).toMatch(UUID_PATTERN);
  });

  it("reports the id that a failed request was logged under", async () => {
    const context = createTestApp();
    context.store.getScenes.mockImplementation(() => {
      throw new Error("boom");
    });

    const response = await request(context.app)
      .get("/api/scenes")
      .set("Cookie", sessionCookie())
      .set("X-Request-Id", "trace-42");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "internal_error", requestId: "trace-42" });
    expect(response.headers["x-request-id"]).toBe("trace-42");
  });
});
