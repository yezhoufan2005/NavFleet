import { describe, expect, it, vi } from "vitest";
import { buildMqttTlsOptions } from "../src/mqtt";
import { parseConfig } from "../src/config";

/**
 * MQTT-over-TLS wiring. The broker side (a mosquitto 8883 listener) is verified by
 * scripts/verify-stack.sh --mqtt-tls against a real stack; what CI can prove without
 * a broker is the client-side decision: which connect options the backend derives
 * from config, and — the part with real failure modes — that a plaintext URL never
 * grows TLS options and an unreadable CA fails loudly rather than silently.
 */
describe("buildMqttTlsOptions", () => {
  const base = {
    mqttUrl: "mqtt://mosquitto:1883",
    mqttCaFile: "",
    mqttTlsRejectUnauthorized: true,
  };
  const neverReads = (): Buffer => {
    throw new Error("CA file should not be read for this case");
  };

  it("returns nothing for a plaintext URL, even if a CA file is set", () => {
    // A stray MQTT_CA_FILE on an mqtt:// deployment must be inert, not a half-applied
    // TLS config. The reader must not even be consulted.
    expect(buildMqttTlsOptions({ ...base, mqttCaFile: "/etc/ca.pem" }, neverReads)).toEqual({});
  });

  it.each(["mqtts://mosquitto:8883", "tls://b:8883", "wss://b/mqtt", "MQTTS://B:8883"])(
    "treats %s as a TLS URL",
    (mqttUrl) => {
      expect(buildMqttTlsOptions({ ...base, mqttUrl }, neverReads)).toEqual({
        rejectUnauthorized: true,
      });
    },
  );

  it("loads the CA file for a TLS URL and passes it through", () => {
    const ca = Buffer.from("-----BEGIN CERTIFICATE-----\n...");
    const read = vi.fn(() => ca);
    const options = buildMqttTlsOptions(
      {
        mqttUrl: "mqtts://mosquitto:8883",
        mqttCaFile: "/certs/ca.crt",
        mqttTlsRejectUnauthorized: true,
      },
      read,
    );
    expect(read).toHaveBeenCalledWith("/certs/ca.crt");
    expect(options).toEqual({ ca, rejectUnauthorized: true });
  });

  it("honours MQTT_TLS_REJECT_UNAUTHORIZED=false (lab escape hatch)", () => {
    expect(
      buildMqttTlsOptions(
        { ...base, mqttUrl: "mqtts://b:8883", mqttTlsRejectUnauthorized: false },
        neverReads,
      ),
    ).toEqual({ rejectUnauthorized: false });
  });

  it("throws a legible error when the CA file cannot be read", () => {
    const read = vi.fn(() => {
      throw new Error("ENOENT: no such file");
    });
    expect(() =>
      buildMqttTlsOptions(
        { mqttUrl: "mqtts://b:8883", mqttCaFile: "/missing.pem", mqttTlsRejectUnauthorized: true },
        read,
      ),
    ).toThrow(/MQTT_CA_FILE could not be read \(\/missing\.pem\).*ENOENT/);
  });
});

describe("parseConfig — MQTT TLS fields", () => {
  it("defaults: no CA file, verification on", () => {
    const c = parseConfig({});
    expect(c.mqttCaFile).toBe("");
    expect(c.mqttTlsRejectUnauthorized).toBe(true);
  });

  it("parses explicit TLS values", () => {
    const c = parseConfig({ MQTT_CA_FILE: "/certs/ca.crt", MQTT_TLS_REJECT_UNAUTHORIZED: "false" });
    expect(c.mqttCaFile).toBe("/certs/ca.crt");
    expect(c.mqttTlsRejectUnauthorized).toBe(false);
  });
});
