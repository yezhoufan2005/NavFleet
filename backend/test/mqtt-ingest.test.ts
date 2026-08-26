import { describe, it, expect, beforeEach, vi } from "vitest";
import type { AppConfig } from "../src/config";
import type { DashboardStore } from "../src/store";

type MessageHandler = (topic: string, payload: Buffer) => Promise<void> | void;

// Populated by the fake client below; the factory only closes over it, so the
// hoisted vi.mock never touches the map before this module body initialises it.
const handlers = new Map<string, MessageHandler>();

vi.mock("mqtt", () => ({
  default: {
    connect: () => ({
      on: (event: string, handler: MessageHandler) => {
        handlers.set(event, handler);
      },
      subscribe: () => undefined,
    }),
  },
}));

import { connectMqtt } from "../src/mqtt";
import { buildTopicScheme } from "../src/topics";
import { createRuntimeState } from "../src/runtimeState";

const config = {
  mqttUrl: "mqtt://127.0.0.1:1883",
  mqttClientId: "test",
  mqttUsername: "",
  mqttPassword: "",
} as unknown as AppConfig;

const setup = () => {
  handlers.clear();
  const applyStatus = vi.fn(async (_deviceId: string, _payload: unknown) => undefined);
  const applyPayload = vi.fn(async (_payload: unknown, _source?: string) => undefined);
  const store = { applyStatus, applyPayload } as unknown as DashboardStore;
  const state = createRuntimeState();
  connectMqtt({
    store,
    topicScheme: buildTopicScheme("/fleet/{deviceId}/vehicle_info"),
    config,
    state,
  });
  const emit = async (topic: string, text: string): Promise<void> => {
    await handlers.get("message")?.(topic, Buffer.from(text, "utf8"));
  };
  return { applyStatus, applyPayload, state, emit };
};

describe("MQTT ingest validation", () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it("accepts a valid telemetry frame", async () => {
    await ctx.emit("/fleet/car-1/vehicle_info", JSON.stringify({ stamp: 1, fusion_loc: { x: 1 } }));
    expect(ctx.applyPayload).toHaveBeenCalledTimes(1);
    expect(ctx.state.mqttMessagesTotal).toBe(1);
    expect(ctx.state.mqttMessagesRejected).toBe(0);
  });

  it("accepts an object or bare boolean status frame", async () => {
    await ctx.emit("/fleet/car-1/status", JSON.stringify({ online: false }));
    await ctx.emit("/fleet/car-1/status", "true");
    expect(ctx.applyStatus).toHaveBeenCalledTimes(2);
    expect(ctx.state.mqttMessagesRejected).toBe(0);
  });

  it("forwards plain-text status frames unchanged to the store", async () => {
    // Unparseable as JSON, so these reach the gate as the raw text; the store's
    // parseOnline() does the trim/lowercase interpretation.
    await ctx.emit("/fleet/car-1/status", "offline");
    await ctx.emit("/fleet/car-1/status", "OFFLINE");
    await ctx.emit("/fleet/car-1/status", "online");
    expect(ctx.applyStatus.mock.calls.map((call) => call[1])).toEqual([
      "offline",
      "OFFLINE",
      "online",
    ]);
    expect(ctx.state.mqttMessagesRejected).toBe(0);
  });

  it("drops unparseable, null, array and primitive payloads without touching the store", async () => {
    await ctx.emit("/fleet/car-1/vehicle_info", "{not json");
    await ctx.emit("/fleet/car-1/vehicle_info", "null");
    await ctx.emit("/fleet/car-1/vehicle_info", "[1,2]");
    await ctx.emit("/fleet/car-1/vehicle_info", "42");
    await ctx.emit("/fleet/car-1/status", "not-a-status");
    expect(ctx.applyPayload).not.toHaveBeenCalled();
    expect(ctx.applyStatus).not.toHaveBeenCalled();
    expect(ctx.state.mqttMessagesTotal).toBe(5);
    expect(ctx.state.mqttMessagesRejected).toBe(5);
  });
});
