import { describe, it, expect, beforeEach } from "vitest";
import { useAlertAck } from "../../src/composables/useAlertAck";

describe("useAlertAck", () => {
  beforeEach(() => {
    useAlertAck().clearAll();
    localStorage.clear();
  });

  it("acknowledges and un-acknowledges by id, and persists to localStorage", () => {
    const ack = useAlertAck();
    expect(ack.isAcknowledged("a-1")).toBe(false);

    ack.acknowledge("a-1");
    expect(ack.isAcknowledged("a-1")).toBe(true);
    expect(JSON.parse(localStorage.getItem("navfleet:acked-alerts") || "[]")).toContain("a-1");

    ack.unacknowledge("a-1");
    expect(ack.isAcknowledged("a-1")).toBe(false);
  });

  it("acknowledges many at once and clears all", () => {
    const ack = useAlertAck();
    ack.acknowledgeMany(["a", "b", "c"]);
    expect(ack.isAcknowledged("a")).toBe(true);
    expect(ack.isAcknowledged("c")).toBe(true);

    ack.clearAll();
    expect(ack.isAcknowledged("a")).toBe(false);
    expect(ack.state.ids.size).toBe(0);
  });

  it("ignores empty ids", () => {
    const ack = useAlertAck();
    ack.acknowledge("");
    expect(ack.state.ids.size).toBe(0);
  });
});
