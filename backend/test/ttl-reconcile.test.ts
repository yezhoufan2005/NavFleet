import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "mongodb";
import { reconcileTtls } from "../src/migrations/ttl";
import { moduleLogger } from "../src/logger";

/**
 * TTL reconciliation over a fake `Db`. The behaviour that matters is a decision — does it
 * issue a `collMod` only when the stored TTL differs from config, does it use `collMod`
 * (never a conflicting `createIndex`) for the alerts index, and does it leave a missing
 * collection alone — so the fake records commands and replays canned collection/index shapes.
 */

interface CommandCall {
  spec: Record<string, unknown>;
}

const createFakeDb = (opts: {
  telemetryExpire?: number | null;
  alertsExpire?: number | null;
  auditExpire?: number | null;
}): { db: Db; commands: CommandCall[] } => {
  const commands: CommandCall[] = [];
  const db = {
    listCollections: (_filter?: unknown) => ({
      toArray: () =>
        Promise.resolve(
          opts.telemetryExpire === null || opts.telemetryExpire === undefined
            ? []
            : [{ name: "telemetry_ts", options: { expireAfterSeconds: opts.telemetryExpire } }],
        ),
    }),
    collection: (name: string) => ({
      indexes: () => {
        if (name === "audit_log") {
          return Promise.resolve(
            opts.auditExpire === null || opts.auditExpire === undefined
              ? [{ name: "_id_" }]
              : [{ name: "_id_" }, { name: "ts_-1", expireAfterSeconds: opts.auditExpire }],
          );
        }
        return Promise.resolve(
          opts.alertsExpire === null || opts.alertsExpire === undefined
            ? [{ name: "_id_" }]
            : [{ name: "_id_" }, { name: "lastSeenAt_1", expireAfterSeconds: opts.alertsExpire }],
        );
      },
    }),
    command: (spec: Record<string, unknown>) => {
      commands.push({ spec });
      return Promise.resolve({});
    },
  } as unknown as Db;
  return { db, commands };
};

const log = moduleLogger("test-ttl");
const ttl = {
  telemetryRetentionSeconds: 100,
  alertsRetentionSeconds: 200,
  auditRetentionSeconds: 300,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("reconcileTtls", () => {
  it("两个 TTL 都和配置一致时不发任何 collMod", async () => {
    const { db, commands } = createFakeDb({ telemetryExpire: 100, alertsExpire: 200 });
    await reconcileTtls(db, ttl, log);
    expect(commands).toEqual([]);
  });

  it("telemetry_ts 的 TTL 漂了 → collMod 到配置值", async () => {
    const { db, commands } = createFakeDb({ telemetryExpire: 999, alertsExpire: 200 });
    await reconcileTtls(db, ttl, log);
    expect(commands).toEqual([{ spec: { collMod: "telemetry_ts", expireAfterSeconds: 100 } }]);
  });

  it("alerts 的 TTL 漂了 → 用 collMod 改索引（不是会冲突的 createIndex）", async () => {
    const { db, commands } = createFakeDb({ telemetryExpire: 100, alertsExpire: 5 });
    await reconcileTtls(db, ttl, log);
    expect(commands).toEqual([
      {
        spec: {
          collMod: "alerts",
          index: { keyPattern: { lastSeenAt: 1 }, expireAfterSeconds: 200 },
        },
      },
    ]);
  });

  it("audit_log 的 TTL 漂了 → 用 collMod 改 ts_-1 索引", async () => {
    const { db, commands } = createFakeDb({
      telemetryExpire: 100,
      alertsExpire: 200,
      auditExpire: 9,
    });
    await reconcileTtls(db, ttl, log);
    expect(commands).toEqual([
      {
        spec: {
          collMod: "audit_log",
          index: { keyPattern: { ts: -1 }, expireAfterSeconds: 300 },
        },
      },
    ]);
  });

  it("集合还不存在（新库刚建好前）时两者都跳过", async () => {
    const { db, commands } = createFakeDb({ telemetryExpire: null, alertsExpire: null });
    await reconcileTtls(db, ttl, log);
    expect(commands).toEqual([]);
  });

  it("两个都漂时各发一条", async () => {
    const { db, commands } = createFakeDb({ telemetryExpire: 1, alertsExpire: 2 });
    await reconcileTtls(db, ttl, log);
    expect(commands).toHaveLength(2);
    expect(commands[0]?.spec).toMatchObject({ collMod: "telemetry_ts" });
    expect(commands[1]?.spec).toMatchObject({ collMod: "alerts" });
  });
});
