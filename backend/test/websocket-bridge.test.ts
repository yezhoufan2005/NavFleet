import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, it, expect, afterEach, vi } from "vitest";
import WebSocket from "ws";
import { ACCESS_COOKIE, type SessionCheck, type UserLookup } from "../src/auth/middleware";
import { signAccessToken } from "../src/auth/tokens";
import {
  createWebSocketBridge,
  rawToText,
  WS_MAX_PAYLOAD_BYTES,
  type WebSocketBridge,
} from "../src/websocket";
import type { AppConfig } from "../src/config";
import type { DashboardStore } from "../src/store";
import type { FleetSnapshot, SocketEvent, UserRecord } from "../src/types";
import { sampleSnapshot } from "./helpers/fixtures";

/**
 * The bridge is exercised over a real HTTP server on an ephemeral port with real
 * `ws` clients, so the upgrade handshake, the auth check and the frame plumbing
 * are all covered. The store is a plain EventEmitter, which also verifies the
 * store -> broadcast wiring.
 */

type StoreStub = EventEmitter & { snapshot: () => FleetSnapshot };

interface Harness {
  bridge: WebSocketBridge;
  store: StoreStub;
  port: number;
  url: string;
}

const servers: http.Server[] = [];
const bridges: WebSocketBridge[] = [];
const clients: WebSocket[] = [];
const rawSockets: net.Socket[] = [];

const token = (): string => signAccessToken({ username: "tester", role: "viewer" }, 0);
const tokenWithSid = (sid = "sid-1"): string =>
  signAccessToken({ username: "tester", role: "viewer" }, 0, sid);

const enabledUser = (): UserRecord => ({
  username: "tester",
  passwordHash: "x",
  role: "viewer",
  createdAt: "t",
  updatedAt: "t",
  enabled: true,
  tokenVersion: 0,
  displayName: "tester",
  email: null,
  phone: null,
  lastLoginAt: null,
  passwordUpdatedAt: "t",
  failedAttempts: 0,
  lockedUntil: null,
});

const startBridge = async (
  options: { authEnabled?: boolean; lookupUser?: UserLookup; isSessionActive?: SessionCheck } = {},
): Promise<Harness> => {
  const store: StoreStub = Object.assign(new EventEmitter(), { snapshot: () => sampleSnapshot() });
  const server = http.createServer();
  servers.push(server);
  const bridge = createWebSocketBridge(
    server,
    store as unknown as DashboardStore,
    {
      authEnabled: options.authEnabled ?? true,
    } as unknown as AppConfig,
    options.lookupUser ?? (() => Promise.resolve(enabledUser())),
    options.isSessionActive,
  );
  bridges.push(bridge);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as net.AddressInfo;
  return { bridge, store, port, url: `ws://127.0.0.1:${port}/ws` };
};

const connect = (
  harness: Harness,
  query = "",
  options: WebSocket.ClientOptions = {},
): WebSocket => {
  const client = new WebSocket(`${harness.url}${query}`, options);
  clients.push(client);
  return client;
};

const authedConnect = (harness: Harness): WebSocket =>
  connect(harness, "", { headers: { Cookie: `${ACCESS_COOKIE}=${token()}` } });

/** Resolve with the next frame; attach before triggering the send. */
const nextMessage = (client: WebSocket): Promise<SocketEvent> =>
  new Promise((resolve, reject) => {
    client.once("message", (raw: WebSocket.RawData) => {
      try {
        // The server's own decoder, so this test reads a frame exactly as the server writes it.
        resolve(JSON.parse(rawToText(raw)) as SocketEvent);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    client.once("error", reject);
  });

const opened = (client: WebSocket): Promise<void> =>
  new Promise((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });

const failed = (client: WebSocket): Promise<Error> =>
  new Promise((resolve) => client.once("error", resolve));

/**
 * Perform the upgrade handshake over a bare TCP socket. Unlike a `ws` client it
 * never answers protocol pings, which is what the heartbeat test needs.
 */
const rawUpgrade = async (
  harness: Harness,
  options: { path?: string; token?: string } = {},
): Promise<net.Socket> => {
  const socket = net.connect(harness.port, "127.0.0.1");
  rawSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });

  const lines = [
    `GET ${options.path ?? "/ws"} HTTP/1.1`,
    `Host: 127.0.0.1:${harness.port}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "Sec-WebSocket-Version: 13",
  ];
  if (options.token) {
    lines.push(`Cookie: ${ACCESS_COOKIE}=${options.token}`);
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  return socket;
};

afterEach(async () => {
  vi.useRealTimers();
  clients.splice(0).forEach((client) => client.terminate());
  rawSockets.splice(0).forEach((socket) => socket.destroy());
  bridges.splice(0).forEach((bridge) => bridge.close());
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("WebSocket upgrade", () => {
  it("rejects the upgrade with 401 when no token is presented", async () => {
    const harness = await startBridge();
    const error = await failed(connect(harness));

    expect(error.message).toContain("401");
    expect(harness.bridge.clientCount()).toBe(0);
  });

  it("rejects the upgrade with 401 for a tampered token", async () => {
    const harness = await startBridge();
    const error = await failed(
      connect(harness, "", { headers: { Cookie: `${ACCESS_COOKIE}=${token()}x` } }),
    );

    expect(error.message).toContain("401");
  });

  it("accepts a cookie token", async () => {
    const harness = await startBridge();
    await opened(authedConnect(harness));

    expect(harness.bridge.clientCount()).toBe(1);
  });

  it("rejects the upgrade with 401 when the account is disabled", async () => {
    const harness = await startBridge({
      lookupUser: () => Promise.resolve({ ...enabledUser(), enabled: false }),
    });
    const error = await failed(
      connect(harness, "", { headers: { Cookie: `${ACCESS_COOKIE}=${token()}` } }),
    );
    expect(error.message).toContain("401");
  });

  it("rejects the upgrade with 401 when the token version is stale", async () => {
    const harness = await startBridge({
      lookupUser: () => Promise.resolve({ ...enabledUser(), tokenVersion: 5 }),
    });
    const error = await failed(
      connect(harness, "", { headers: { Cookie: `${ACCESS_COOKIE}=${token()}` } }),
    );
    expect(error.message).toContain("401");
  });

  it("rejects the upgrade with 401 when the token's session has been revoked", async () => {
    // The user is fine (enabled, current version) but the session the token names is gone —
    // the same per-request check the REST gate makes, applied once at the handshake.
    const harness = await startBridge({ isSessionActive: () => Promise.resolve(false) });
    const error = await failed(
      connect(harness, "", { headers: { Cookie: `${ACCESS_COOKIE}=${tokenWithSid()}` } }),
    );
    expect(error.message).toContain("401");
  });

  it("accepts a token whose session is still live", async () => {
    const harness = await startBridge({ isSessionActive: () => Promise.resolve(true) });
    await opened(
      connect(harness, "", { headers: { Cookie: `${ACCESS_COOKIE}=${tokenWithSid()}` } }),
    );
    expect(harness.bridge.clientCount()).toBe(1);
  });

  it("rejects a token passed in the query string", async () => {
    // A token in a URL leaks into access logs, Referer headers and history, so
    // the cookie is the only accepted carrier.
    const harness = await startBridge();
    const error = await failed(connect(harness, `?access_token=${encodeURIComponent(token())}`));

    expect(error.message).toContain("401");
    expect(harness.bridge.clientCount()).toBe(0);
  });

  it("accepts an anonymous client when auth is disabled", async () => {
    const harness = await startBridge({ authEnabled: false });
    await opened(connect(harness));

    expect(harness.bridge.clientCount()).toBe(1);
  });

  it("destroys the socket for an upgrade on any other path", async () => {
    const harness = await startBridge();
    const socket = await rawUpgrade(harness, { path: "/not-ws", token: token() });
    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk));

    await new Promise<void>((resolve) => socket.once("close", () => resolve()));

    // No HTTP response at all, and no client registered.
    expect(Buffer.concat(received)).toHaveLength(0);
    expect(harness.bridge.clientCount()).toBe(0);
  });
});

describe("WebSocket session", () => {
  it("sends the fleet snapshot on connect", async () => {
    const harness = await startBridge();
    const client = authedConnect(harness);
    const first = await nextMessage(client);

    expect(first.type).toBe("fleet.snapshot");
    expect(first.payload).toEqual(sampleSnapshot());
  });

  it("answers an app-level ping with a pong", async () => {
    const harness = await startBridge();
    const client = authedConnect(harness);
    await nextMessage(client);

    const pong = nextMessage(client);
    client.send(JSON.stringify({ type: "ping" }));

    expect(await pong).toEqual({ type: "pong", payload: null });
  });

  it("ignores a non-JSON message without dropping the connection", async () => {
    const harness = await startBridge();
    const client = authedConnect(harness);
    await nextMessage(client);

    client.send("not json at all");
    const pong = nextMessage(client);
    client.send(JSON.stringify({ type: "ping" }));

    expect((await pong).type).toBe("pong");
    expect(harness.bridge.clientCount()).toBe(1);
  });
});

describe("WebSocket broadcast", () => {
  const event: SocketEvent = { type: "device.offline", payload: { deviceId: "agv-1" } };

  it("fans a broadcast out to every connected client", async () => {
    const harness = await startBridge();
    const first = authedConnect(harness);
    const second = authedConnect(harness);
    await Promise.all([nextMessage(first), nextMessage(second)]);
    expect(harness.bridge.clientCount()).toBe(2);

    const received = Promise.all([nextMessage(first), nextMessage(second)]);
    harness.bridge.broadcast(event);

    expect(await received).toEqual([event, event]);
  });

  it("forwards store change events to connected clients", async () => {
    const harness = await startBridge();
    const client = authedConnect(harness);
    await nextMessage(client);

    const received = nextMessage(client);
    harness.store.emit("event", event);

    expect(await received).toEqual(event);
  });

  it("does not count a healthy, draining client as a slow broadcast", async () => {
    // The slow-consumer counter (navfleet_ws_broadcast_slow_total) must not fire for a
    // client that is keeping up — otherwise the signal is noise. A client whose buffer is
    // over 1 MiB at send time is the only thing that trips it, which does not happen here.
    const harness = await startBridge();
    const client = authedConnect(harness);
    await nextMessage(client);
    expect(harness.bridge.slowBroadcastCount()).toBe(0);

    const received = nextMessage(client);
    harness.bridge.broadcast(event);
    await received;

    expect(harness.bridge.slowBroadcastCount()).toBe(0);
  });
});

describe("WebSocket heartbeat", () => {
  it("terminates a client that never answers a protocol ping", async () => {
    // Only the interval is faked: the handshake and the termination still travel
    // over real sockets.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const harness = await startBridge();
    const socket = await rawUpgrade(harness, { token: token() });
    // The 101 response (and the snapshot frame) arrive together.
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));
    expect(harness.bridge.clientCount()).toBe(1);

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    // First tick marks the connection unhealthy and pings it; the raw socket
    // never answers, so the second tick terminates it.
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();

    await closed;
    await vi.waitFor(() => {
      expect(harness.bridge.clientCount()).toBe(0);
    });
  });

  it("keeps a client that answers the protocol ping", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const harness = await startBridge();
    // A real `ws` client answers protocol pings automatically.
    const client = authedConnect(harness);
    await nextMessage(client);

    const pinged = new Promise<void>((resolve) => client.once("ping", () => resolve()));
    await vi.advanceTimersByTimeAsync(30_000);
    await pinged;

    // The client queues its pong before emitting "ping", so an app-level
    // ping/pong round trip afterwards proves the server has already processed
    // that pong (frames are delivered in order) and marked the socket alive.
    const appPong = nextMessage(client);
    client.send(JSON.stringify({ type: "ping" }));
    expect((await appPong).type).toBe("pong");

    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();

    expect(harness.bridge.clientCount()).toBe(1);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });
});

/**
 * Both cases below fail before the connection-error fix, and they fail the whole
 * file rather than a single assertion: `ws` reports these two conditions by
 * emitting "error" on the server-side WebSocket, and a Node EventEmitter with no
 * "error" listener rethrows. That escapes into the process, where
 * `uncaughtException` is wired to shut the backend down — so one connection's
 * problem took the whole service with it.
 */
describe("WebSocket connection errors", () => {
  it("survives a malformed frame and leaves other clients connected", async () => {
    const harness = await startBridge();
    const bystander = authedConnect(harness);
    await nextMessage(bystander);

    const socket = await rawUpgrade(harness, { token: token() });
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));
    await vi.waitFor(() => {
      expect(harness.bridge.clientCount()).toBe(2);
    });

    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    // FIN + RSV1 set, opcode 1, masked, zero length. RSV1 must be clear when no
    // extension negotiated it, so the receiver rejects the frame.
    socket.write(Buffer.from([0xc1, 0x80, 0x00, 0x00, 0x00, 0x00]));
    await closed;

    await vi.waitFor(() => {
      expect(harness.bridge.clientCount()).toBe(1);
    });

    const pong = nextMessage(bystander);
    bystander.send(JSON.stringify({ type: "ping" }));
    expect((await pong).type).toBe("pong");
    expect(bystander.readyState).toBe(WebSocket.OPEN);
  });

  it("rejects a frame over the payload limit without dropping other clients", async () => {
    const harness = await startBridge();
    const bystander = authedConnect(harness);
    await nextMessage(bystander);

    const offender = authedConnect(harness);
    await nextMessage(offender);
    // The client sees its own connection fail; that is expected here.
    offender.on("error", () => undefined);

    const closed = new Promise<void>((resolve) => offender.once("close", () => resolve()));
    offender.send(Buffer.alloc(WS_MAX_PAYLOAD_BYTES + 1));
    await closed;

    await vi.waitFor(() => {
      expect(harness.bridge.clientCount()).toBe(1);
    });

    const pong = nextMessage(bystander);
    bystander.send(JSON.stringify({ type: "ping" }));
    expect((await pong).type).toBe("pong");
  });
});
