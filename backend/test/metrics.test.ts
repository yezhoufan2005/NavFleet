import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Server } from "node:http";
import { DEVICE_ID, createTestApp, sessionCookie } from "./helpers/testApp";

/**
 * The exposition is scraped by Prometheus, so these tests read it as text the
 * way a scraper would rather than reaching into prom-client internals.
 */
const scrape = async (app: Server): Promise<string> => {
  const response = await request(app).get("/metrics");
  expect(response.status).toBe(200);
  return response.text;
};

/**
 * Sample lines for exactly one metric family, excluding # HELP/# TYPE comments.
 * Matching is anchored on the delimiter after the name so a prefix family
 * (`navfleet_up`) never picks up a longer one (`navfleet_uptime_seconds`).
 */
const samplesFor = (body: string, metric: string): string[] =>
  body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${metric} `) || line.startsWith(`${metric}{`));

const HISTOGRAM_COUNT = "navfleet_http_request_duration_seconds_count";

/**
 * Scrape until every expected histogram sample is present, then return the body.
 *
 * A request is observed in `response.on("finish")`, and supertest's promise
 * resolves when the *client* has the full response — the server-side finish
 * callback usually runs first but is not ordered against it. Asserting on an
 * immediate scrape was flaky (one run in three), so wait for the samples under
 * test instead of sleeping on a guess.
 */
const scrapeUntil = async (app: Server, expected: string[]): Promise<string> => {
  let body = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    body = await scrape(app);
    const samples = samplesFor(body, HISTOGRAM_COUNT);
    if (expected.every((line) => samples.includes(line))) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `expected histogram samples never appeared.\nwanted:\n${expected.join("\n")}\ngot:\n${samplesFor(
      body,
      HISTOGRAM_COUNT,
    ).join("\n")}`,
  );
};

describe("metric exposition", () => {
  it("keeps the metric names and types the previous hand-rolled exposition published", async () => {
    const { app } = createTestApp({ wsClientCount: () => 3 });
    const body = await scrape(app);

    for (const name of [
      "navfleet_up",
      "navfleet_uptime_seconds",
      "navfleet_devices_total",
      "navfleet_devices_online",
      "navfleet_alerts_active",
      "navfleet_ws_connections",
      "navfleet_mongo_connected",
      "navfleet_mongo_buffer_pending",
      "navfleet_mongo_buffer_dropped_total",
      "navfleet_mqtt_connected",
      "navfleet_mqtt_messages_total",
      "navfleet_mqtt_messages_rejected_total",
    ]) {
      expect(body).toContain(`# HELP ${name} `);
    }

    // rate() over the ingest counters only works if they are exposed as counters.
    expect(body).toContain("# TYPE navfleet_mqtt_messages_total counter");
    expect(body).toContain("# TYPE navfleet_mqtt_messages_rejected_total counter");
    expect(body).toContain("# TYPE navfleet_ws_connections gauge");

    expect(samplesFor(body, "navfleet_up")).toEqual(["navfleet_up 1"]);
    expect(samplesFor(body, "navfleet_ws_connections")).toEqual(["navfleet_ws_connections 3"]);
    expect(samplesFor(body, "navfleet_devices_total")).toEqual(["navfleet_devices_total 1"]);
    expect(samplesFor(body, "navfleet_mongo_connected")).toEqual(["navfleet_mongo_connected 0"]);
  });

  it("reads live collaborator state at scrape time, not at startup", async () => {
    const context = createTestApp();
    expect(await scrape(context.app)).toContain("navfleet_mongo_connected 0");

    context.persistence.isMongoConnected.mockReturnValue(true);
    context.state.mqttConnected = true;
    context.state.mqttMessagesTotal = 41;
    context.state.mqttMessagesRejected = 2;

    const body = await scrape(context.app);
    expect(body).toContain("navfleet_mongo_connected 1");
    expect(body).toContain("navfleet_mqtt_connected 1");
    expect(samplesFor(body, "navfleet_mqtt_messages_total")).toEqual([
      "navfleet_mqtt_messages_total 41",
    ]);
    expect(samplesFor(body, "navfleet_mqtt_messages_rejected_total")).toEqual([
      "navfleet_mqtt_messages_rejected_total 2",
    ]);
  });

  it("gives each app its own registry so instances never read each other's state", async () => {
    const first = createTestApp({ wsClientCount: () => 1 });
    const second = createTestApp({ wsClientCount: () => 9 });

    expect(await scrape(first.app)).toContain("navfleet_ws_connections 1");
    expect(await scrape(second.app)).toContain("navfleet_ws_connections 9");
  });

  it("omits process metrics unless the composition root asks for them", async () => {
    const withoutDefaults = await scrape(createTestApp().app);
    expect(withoutDefaults).not.toContain("navfleet_process_");

    const withDefaults = await scrape(createTestApp({ collectDefaultMetrics: true }).app);
    expect(withDefaults).toContain("navfleet_process_process_cpu_seconds_total");
    expect(withDefaults).toContain("navfleet_process_nodejs_heap_size_used_bytes");
  });
});

describe("http request duration histogram", () => {
  it("labels a request with its route template, never the concrete path", async () => {
    const context = createTestApp();
    await request(context.app)
      .get(`/api/devices/${DEVICE_ID}/history`)
      .set("Cookie", sessionCookie());

    const body = await scrapeUntil(context.app, [
      `${HISTOGRAM_COUNT}{method="GET",route="/api/devices/:deviceId/history",status="200"} 1`,
    ]);

    // The whole point of the template: one device id per series would make the
    // histogram's cardinality grow with the fleet.
    expect(body).not.toContain(DEVICE_ID);
  });

  it("collapses unmatched paths into a single series", async () => {
    const context = createTestApp();
    await request(context.app).get("/api/nope/one").set("Cookie", sessionCookie());
    await request(context.app).get("/api/nope/two").set("Cookie", sessionCookie());

    await scrapeUntil(context.app, [
      `${HISTOGRAM_COUNT}{method="GET",route="unmatched",status="404"} 2`,
    ]);
  });

  it("separates statuses on the same route", async () => {
    const context = createTestApp();
    await request(context.app).get("/api/fleet/snapshot").set("Cookie", sessionCookie());
    context.store.snapshot.mockImplementation(() => {
      throw new Error("boom");
    });
    await request(context.app).get("/api/fleet/snapshot").set("Cookie", sessionCookie());

    await scrapeUntil(context.app, [
      `${HISTOGRAM_COUNT}{method="GET",route="/api/fleet/snapshot",status="200"} 1`,
      `${HISTOGRAM_COUNT}{method="GET",route="/api/fleet/snapshot",status="500"} 1`,
    ]);
  });

  it("attributes an auth-gate rejection to `unmatched`, distinguished by its status", async () => {
    // Documents a real consequence of labelling by Express's matched route: the
    // auth middleware answers 401 before any route matches, so there is no
    // template to attribute the request to. The status label still separates
    // blocked traffic (401) from genuinely unknown paths (404).
    const context = createTestApp();
    await request(context.app).get("/api/fleet/snapshot");

    await scrapeUntil(context.app, [
      `${HISTOGRAM_COUNT}{method="GET",route="unmatched",status="401"} 1`,
    ]);
  });

  it("records a bounded, plausible duration", async () => {
    const context = createTestApp();
    await request(context.app).get("/api/formations").set("Cookie", sessionCookie());

    const body = await scrapeUntil(context.app, [
      `${HISTOGRAM_COUNT}{method="GET",route="/api/formations",status="200"} 1`,
    ]);
    const sum = samplesFor(body, "navfleet_http_request_duration_seconds_sum")
      .map((line) => Number(line.split(" ").pop()))
      .find((value) => Number.isFinite(value));

    expect(sum).toBeGreaterThan(0);
    expect(sum).toBeLessThan(5);
  });
});
