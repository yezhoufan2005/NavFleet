import { describe, it, expect, vi } from "vitest";
import type { DeviceAlert, NotifyConfig, NotifySendRecord, Severity } from "../src/types";
import { postWithRetry } from "../src/notify/retry";
import {
  buildChannelBody,
  buildDingtalkBody,
  buildWebhookBody,
  buildWecomBody,
} from "../src/notify/channels";
import { selectChannelsForAlert } from "../src/notify/routing";
import { NotifyService, type NotifyDevice } from "../src/notify/service";

/**
 * 告警外发（Phase 16D-1）。四块：重试/超时包装、渠道正文构造（纯）、路由选择（纯）、以及把三者
 * 串起来的 NotifyService。红线由 dispatcher 的用例守住：零渠道不发、env 未配跳过、失败被容纳不外抛。
 */

const alertOf = (over: Partial<DeviceAlert> = {}): DeviceAlert => ({
  id: "agv-1-low-soc",
  title: "低电量预警",
  detail: "当前电量 15%，建议尽快安排回充",
  severity: "warning",
  source: "rule-engine",
  ts: "2026-09-19T00:00:00.000Z",
  active: true,
  ...over,
});

/** A minimal `fetch`-shaped stub: only `ok` + `status` are read by `postWithRetry`. */
const respond = (status: number): Response =>
  ({ ok: status >= 200 && status < 300, status }) as unknown as Response;

const noSleep = (): Promise<void> => Promise.resolve();

describe("postWithRetry", () => {
  const opts = (fetchImpl: typeof fetch) => ({
    maxAttempts: 3,
    timeoutMs: 1000,
    fetchImpl,
    sleep: noSleep,
  });

  it("returns ok on a 2xx first try, one attempt", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(200))) as unknown as typeof fetch;
    const outcome = await postWithRetry("https://example/hook", { a: 1 }, opts(fetchImpl));
    expect(outcome).toMatchObject({ ok: true, httpStatus: 200, attempts: 1, error: null });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries a 500 and succeeds on a later attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(respond(500))
      .mockResolvedValueOnce(respond(204)) as unknown as typeof fetch;
    const outcome = await postWithRetry("https://example/hook", {}, opts(fetchImpl));
    expect(outcome).toMatchObject({ ok: true, httpStatus: 204, attempts: 2 });
  });

  it("gives up after maxAttempts on a persistent 5xx", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(503))) as unknown as typeof fetch;
    const outcome = await postWithRetry("https://example/hook", {}, opts(fetchImpl));
    expect(outcome).toMatchObject({ ok: false, httpStatus: 503, attempts: 3, error: "HTTP 503" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 4xx other than 429", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(400))) as unknown as typeof fetch;
    const outcome = await postWithRetry("https://example/hook", {}, opts(fetchImpl));
    expect(outcome).toMatchObject({ ok: false, httpStatus: 400, attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retries a 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(respond(429))
      .mockResolvedValueOnce(respond(200)) as unknown as typeof fetch;
    const outcome = await postWithRetry("https://example/hook", {}, opts(fetchImpl));
    expect(outcome).toMatchObject({ ok: true, attempts: 2 });
  });

  it("folds a thrown network error into a failed outcome (httpStatus null)", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error("ECONNRESET")),
    ) as unknown as typeof fetch;
    const outcome = await postWithRetry("https://example/hook", {}, opts(fetchImpl));
    expect(outcome).toMatchObject({
      ok: false,
      httpStatus: null,
      attempts: 3,
      error: "ECONNRESET",
    });
  });
});

describe("channel bodies", () => {
  const context = {
    deviceId: "agv-1",
    deviceName: "叉车 1",
    alertId: "agv-1-offline",
    severity: "critical" as Severity,
    title: "设备离线",
    detail: "超过离线阈值未上报",
    source: "rule-engine",
    ts: "2026-09-19T00:00:00.000Z",
  };

  it("webhook body is the flat alert object", () => {
    expect(buildWebhookBody(context)).toMatchObject({
      deviceId: "agv-1",
      deviceName: "叉车 1",
      severity: "critical",
      title: "设备离线",
    });
  });

  it("wecom body is a markdown envelope naming severity + device", () => {
    const body = buildWecomBody(context) as { msgtype: string; markdown: { content: string } };
    expect(body.msgtype).toBe("markdown");
    expect(body.markdown.content).toContain("严重");
    expect(body.markdown.content).toContain("叉车 1");
    expect(body.markdown.content).toContain("agv-1");
  });

  it("dingtalk body carries a title and markdown text", () => {
    const body = buildDingtalkBody(context) as {
      msgtype: string;
      markdown: { title: string; text: string };
    };
    expect(body.msgtype).toBe("markdown");
    expect(body.markdown.title).toContain("设备离线");
    expect(body.markdown.text).toContain("超过离线阈值未上报");
  });

  it("buildChannelBody dispatches on type", () => {
    expect(buildChannelBody("webhook", context)).toHaveProperty("deviceId");
    expect(buildChannelBody("wecom", context)).toHaveProperty("msgtype", "markdown");
    expect(buildChannelBody("dingtalk", context)).toHaveProperty("msgtype", "markdown");
  });
});

describe("selectChannelsForAlert", () => {
  const scopeDevice = { deviceId: "agv-1", formationIds: ["f-a"], tags: ["cold"] };
  const channel = (over: Partial<NotifyConfig["channels"][number]> = {}) => ({
    id: "c",
    type: "webhook" as const,
    enabled: true,
    urlEnv: "E",
    severities: ["critical", "warning", "notice"] as Severity[],
    ...over,
  });

  it("skips disabled channels", () => {
    const config = { channels: [channel({ enabled: false })] };
    expect(selectChannelsForAlert(config, { severity: "critical" }, scopeDevice)).toEqual([]);
  });

  it("filters by severity", () => {
    const config = { channels: [channel({ severities: ["critical"] })] };
    expect(selectChannelsForAlert(config, { severity: "warning" }, scopeDevice)).toEqual([]);
    expect(selectChannelsForAlert(config, { severity: "critical" }, scopeDevice)).toHaveLength(1);
  });

  it("filters by scope (device out of a scoped channel is skipped)", () => {
    const config = { channels: [channel({ scope: { formationIds: ["f-b"] } })] };
    expect(selectChannelsForAlert(config, { severity: "critical" }, scopeDevice)).toEqual([]);
    const inScope = { channels: [channel({ scope: { tags: ["cold"] } })] };
    expect(selectChannelsForAlert(inScope, { severity: "critical" }, scopeDevice)).toHaveLength(1);
  });
});

describe("NotifyService.dispatch", () => {
  const device: NotifyDevice = {
    deviceId: "agv-1",
    deviceName: "叉车 1",
    formationIds: ["f-a"],
    tags: ["cold"],
  };
  const channel = {
    id: "ops-webhook",
    type: "webhook" as const,
    enabled: true,
    urlEnv: "NAVFLEET_TEST_WEBHOOK_URL",
    severities: ["critical", "warning", "notice"] as Severity[],
  };

  const makeService = (
    over: {
      config?: NotifyConfig;
      env?: Record<string, string>;
      fetchImpl?: typeof fetch;
      resolveDevice?: (id: string) => NotifyDevice | null;
    } = {},
  ) => {
    const records: NotifySendRecord[] = [];
    const persistence = {
      appendNotify: vi.fn((record: NotifySendRecord) => {
        records.push(record);
        return Promise.resolve();
      }),
      queryNotify: vi.fn(() => Promise.resolve(records)),
    };
    const service = new NotifyService({
      persistence: persistence,
      getNotifyConfig: () => over.config ?? { channels: [channel] },
      resolveDevice: over.resolveDevice ?? (() => device),
      maxAttempts: 2,
      timeoutMs: 500,
      resolveEnv: (name) => (over.env ?? { NAVFLEET_TEST_WEBHOOK_URL: "https://hook" })[name],
      fetchImpl: over.fetchImpl ?? vi.fn(() => Promise.resolve(respond(200))),
      now: () => new Date("2026-09-19T00:00:00.000Z"),
    });
    return { service, records, persistence };
  };

  it("sends to a matching channel and records a 'sent'", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(200))) as unknown as typeof fetch;
    const { service, records } = makeService({ fetchImpl });
    await service.dispatch({ source: "mqtt", deviceId: "agv-1", alert: alertOf() });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      channelId: "ops-webhook",
      eventKey: "agv-1:agv-1-low-soc",
      status: "sent",
      httpStatus: 200,
    });
  });

  it("records a 'failed' when the endpoint keeps erroring", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(500))) as unknown as typeof fetch;
    const { service, records } = makeService({ fetchImpl });
    await service.dispatch({ source: "mqtt", deviceId: "agv-1", alert: alertOf() });
    expect(records[0]).toMatchObject({ status: "failed", httpStatus: 500 });
  });

  it("sends nothing and records nothing when there are no channels (zero-config)", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(200))) as unknown as typeof fetch;
    const { service, records } = makeService({ config: { channels: [] }, fetchImpl });
    await service.dispatch({ source: "mqtt", deviceId: "agv-1", alert: alertOf() });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
  });

  it("skips a channel whose endpoint env is unset — no send, no record", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(200))) as unknown as typeof fetch;
    const { service, records } = makeService({ env: {}, fetchImpl });
    await service.dispatch({ source: "mqtt", deviceId: "agv-1", alert: alertOf() });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
  });

  it("does not send when severity is not subscribed", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(200))) as unknown as typeof fetch;
    const { service, records } = makeService({
      config: { channels: [{ ...channel, severities: ["critical"] }] },
      fetchImpl,
    });
    await service.dispatch({
      source: "mqtt",
      deviceId: "agv-1",
      alert: alertOf({ severity: "warning" }),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
  });

  it("contains a resolveDevice throw rather than rejecting (fire-and-forget safety)", async () => {
    const { service, records } = makeService({
      resolveDevice: () => {
        throw new Error("boom");
      },
    });
    await expect(
      service.dispatch({ source: "mqtt", deviceId: "agv-1", alert: alertOf() }),
    ).resolves.toBeUndefined();
    expect(records).toHaveLength(0);
  });

  it("still fires fleet-wide channels when the device is unknown", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(respond(200))) as unknown as typeof fetch;
    const { service, records } = makeService({ resolveDevice: () => null, fetchImpl });
    await service.dispatch({ source: "mqtt", deviceId: "ghost", alert: alertOf() });
    expect(records[0]).toMatchObject({ deviceId: "ghost", status: "sent" });
  });
});

describe("NotifyService read APIs", () => {
  it("effectiveConfig redacts urlEnv and reports configured from env presence", () => {
    const service = new NotifyService({
      persistence: { appendNotify: vi.fn(), queryNotify: vi.fn() },
      getNotifyConfig: () => ({
        channels: [
          {
            id: "a",
            type: "wecom",
            enabled: true,
            urlEnv: "SET_ENV",
            severities: ["critical"],
          },
          {
            id: "b",
            type: "webhook",
            enabled: true,
            urlEnv: "UNSET_ENV",
            severities: ["critical", "warning", "notice"],
          },
        ],
      }),
      resolveDevice: () => null,
      maxAttempts: 1,
      timeoutMs: 100,
      resolveEnv: (name) => (name === "SET_ENV" ? "https://hook" : undefined),
    });

    const view = service.effectiveConfig();
    expect(view).toHaveLength(2);
    expect(view[0]).toMatchObject({ id: "a", configured: true });
    expect(view[1]).toMatchObject({ id: "b", configured: false });
    // The URL / env-var value is never exposed.
    expect(JSON.stringify(view)).not.toContain("https://hook");
    expect(view[0]).not.toHaveProperty("urlEnv");
  });

  it("queryLog delegates to persistence.queryNotify", async () => {
    const queryNotify = vi.fn(() => Promise.resolve([]));
    const service = new NotifyService({
      persistence: { appendNotify: vi.fn(), queryNotify },
      getNotifyConfig: () => ({ channels: [] }),
      resolveDevice: () => null,
      maxAttempts: 1,
      timeoutMs: 100,
    });
    await service.queryLog({ deviceId: "agv-1", status: "failed" });
    expect(queryNotify).toHaveBeenCalledWith({ deviceId: "agv-1", status: "failed" });
  });
});
