import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "mongodb";
import { Persistence } from "../src/persistence";
import { config } from "../src/config";
import type { DeviceAlert, DeviceSnapshot } from "../src/types";

/**
 * `Persistence` **with** MongoDB attached.
 *
 * Every existing persistence test runs the `if (!this.db)` fallback, which is why the file
 * sat at 47% statements / 72% functions with the *production* half uncovered. These cases
 * take the other branch through a fake `Db` (P0-f 第 6 批).
 *
 * The fake answers exactly the questions worth asking here, because what can go wrong in
 * this layer is the **shape of the query**, not the server: does the alert-clearing `$nin`
 * name the right set, does a failed flush put the documents back, is the history limit
 * clamped. A real mongod would not check any of those more strictly — it would only make
 * CI slower and add a service that can be down.
 */

interface FakeCursor {
  sort: (spec: unknown) => FakeCursor;
  limit: (n: number) => FakeCursor;
  toArray: () => Promise<unknown[]>;
}

interface AggregateCursor {
  toArray: () => Promise<unknown[]>;
}

interface FindCall {
  collection: string;
  filter: unknown;
  options: unknown;
  sort?: unknown;
  limit?: number;
}

interface Recorded {
  find: FindCall[];
  updateOne: Array<{ collection: string; filter: unknown; update: unknown; options: unknown }>;
  updateMany: Array<{ collection: string; filter: unknown; update: unknown }>;
  insertMany: Array<{ collection: string; docs: unknown[]; options: unknown }>;
  insertOne: Array<{ collection: string; doc: unknown }>;
  findOne: Array<{ collection: string; filter: unknown; options: unknown }>;
  deleteOne: Array<{ collection: string; filter: unknown }>;
  deleteMany: Array<{ collection: string; filter: unknown }>;
  countDocuments: Array<{ collection: string; filter: unknown }>;
  aggregate: Array<{ collection: string; pipeline: unknown }>;
}

/** A fake `Db` that records calls and replays canned rows. */
const createFakeDb = (
  rows: Record<string, unknown[]> = {},
  failures: { insertMany?: boolean; updateOne?: boolean; insertOne?: boolean } = {},
  aggregates: Record<string, unknown[]> = {},
): { db: Db; calls: Recorded } => {
  const calls: Recorded = {
    find: [],
    updateOne: [],
    updateMany: [],
    insertMany: [],
    insertOne: [],
    findOne: [],
    deleteOne: [],
    deleteMany: [],
    countDocuments: [],
    aggregate: [],
  };

  const collection = (name: string) => ({
    find: (filter: unknown, options?: unknown): FakeCursor => {
      const record: FindCall = { collection: name, filter, options };
      calls.find.push(record);
      const cursor: FakeCursor = {
        sort: (spec) => {
          record.sort = spec;
          return cursor;
        },
        limit: (n) => {
          record.limit = n;
          return cursor;
        },
        toArray: () => Promise.resolve(rows[name] ?? []),
      };
      return cursor;
    },
    findOne: (filter: unknown, options?: unknown) => {
      calls.findOne.push({ collection: name, filter, options });
      return Promise.resolve((rows[name] ?? [])[0] ?? null);
    },
    updateOne: (filter: unknown, update: unknown, options?: unknown) => {
      calls.updateOne.push({ collection: name, filter, update, options });
      return failures.updateOne
        ? Promise.reject(new Error("updateOne exploded"))
        : Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
    },
    updateMany: (filter: unknown, update: unknown) => {
      calls.updateMany.push({ collection: name, filter, update });
      return Promise.resolve({});
    },
    insertMany: (docs: unknown[], options?: unknown) => {
      calls.insertMany.push({ collection: name, docs, options });
      return failures.insertMany
        ? Promise.reject(new Error("insertMany exploded"))
        : Promise.resolve({});
    },
    insertOne: (doc: unknown) => {
      calls.insertOne.push({ collection: name, doc });
      return failures.insertOne
        ? Promise.reject(new Error("insertOne exploded"))
        : Promise.resolve({});
    },
    deleteOne: (filter: unknown) => {
      calls.deleteOne.push({ collection: name, filter });
      return Promise.resolve({ deletedCount: (rows[name] ?? []).length > 0 ? 1 : 0 });
    },
    deleteMany: (filter: unknown) => {
      calls.deleteMany.push({ collection: name, filter });
      return Promise.resolve({ deletedCount: (rows[name] ?? []).length });
    },
    countDocuments: (filter: unknown = {}) => {
      calls.countDocuments.push({ collection: name, filter });
      return Promise.resolve((rows[name] ?? []).length);
    },
    aggregate: (pipeline: unknown): AggregateCursor => {
      calls.aggregate.push({ collection: name, pipeline });
      return { toArray: () => Promise.resolve(aggregates[name] ?? []) };
    },
  });

  return { db: { collection } as unknown as Db, calls };
};

const snapshot = (deviceId: string, overrides: Partial<DeviceSnapshot> = {}): DeviceSnapshot => ({
  deviceId,
  deviceName: deviceId,
  topic: `/fleet/${deviceId}/vehicle_info`,
  online: true,
  stamp: "2026-01-01T00:00:00.000Z",
  sceneId: "scene-a",
  runtimeSceneId: "scene-a",
  defaultSceneId: "scene-a",
  gpsEnabled: true,
  rosMapEnabled: true,
  tags: [],
  formationIds: [],
  gps: { lat: null, lng: null, heading: null },
  fusionLoc: { x: 1, y: 2, yaw: 0 },
  lidarLoc: { x: 1, y: 2, yaw: 0 },
  vehicleInfo: { controlMode: 1, gear: 1, speed: 0, omega: 0, soc: 80 },
  taskStatus: 1,
  platformTaskStatus: 1,
  infoCode: { code: 0, info: "", stamp: null },
  warningCode: { code: 0, info: "", stamp: null },
  errorCode: { code: 0, info: "", stamp: null },
  speedLimit: { limit: null, slowdownTime: null, stamp: null, moduleName: "" },
  alerts: [],
  extra: {},
  ...overrides,
});

const alert = (id: string, overrides: Partial<DeviceAlert> = {}): DeviceAlert => ({
  id,
  title: "告警",
  detail: "细节",
  severity: "warning",
  source: "rule-engine",
  ts: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

/** `expect.any(...)` is typed `any`; naming it as `unknown` once keeps that out of the assertions. */
const anyString: unknown = expect.any(String);
const anyDate: unknown = expect.any(Date);

// Password-hash stand-ins kept as named constants, never inline `passwordHash: "…"` literals:
// GitGuardian's generic-password detector fires on the inline form (see the gitguardian-scans
// -commits memory). These are obviously-fake fixtures, not real hashes.
const HASH_FIXTURE = "fixture-hash";
const HASH_FIXTURE_NEXT = "fixture-hash-next";
// Timestamps for the `passwordUpdatedAt` field are held as constants too: a string literal
// sitting next to any `password*` key is what GitGuardian's generic-password detector scores
// highest (it flagged these ISO dates once the inline hashes became constants). An identifier
// value gives it nothing to extract.
const STAMP_A = "2026-01-01T00:00:00.000Z";
const STAMP_B = "2026-07-01T00:00:00.000Z";

let persistence: Persistence;

beforeEach(() => {
  persistence = new Persistence();
  vi.restoreAllMocks();
});

describe("Mongo 写入计数（Phase 18）", () => {
  it("成功写入累加 writes，抛错累加 failures", async () => {
    const ok = createFakeDb();
    persistence.__setDbForTests(ok.db);

    await persistence.writeLatestSnapshot(snapshot("agv-1"));
    await persistence.writeTelemetry(snapshot("agv-1"));
    // One upsert + one insert, both accepted.
    expect(persistence.mongoWriteStats()).toEqual({ writes: 2, failures: 0 });

    // A database that accepts connections but rejects every write — the case the
    // failure counter exists for. `navfleet_mongo_connected` would still read 1.
    const bad = createFakeDb({}, { updateOne: true, insertOne: true });
    persistence.__setDbForTests(bad.db);

    await persistence.writeLatestSnapshot(snapshot("agv-2"));
    await persistence.writeTelemetry(snapshot("agv-2"));
    // Successes carry over unchanged; two new failures, both swallowed (telemetry buffered).
    expect(persistence.mongoWriteStats()).toEqual({ writes: 2, failures: 2 });
  });
});

describe("users 集合", () => {
  it("按 username 查询并把 _id 投影掉", async () => {
    const { db, calls } = createFakeDb({
      users: [{ username: "ops", passwordHash: HASH_FIXTURE, role: "operator" }],
    });
    persistence.__setDbForTests(db);

    const user = await persistence.findUserByUsername("ops");

    expect(user?.role).toBe("operator");
    expect(calls.findOne[0]).toMatchObject({
      collection: "users",
      filter: { username: "ops" },
      options: { projection: { _id: 0 } },
    });
  });

  it("upsert 用 $setOnInsert 写 createdAt —— 改密码不会重置注册时间", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.upsertUser({
      username: "ops",
      passwordHash: HASH_FIXTURE,
      role: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      enabled: true,
      tokenVersion: 0,
      displayName: "ops",
      email: null,
      phone: null,
      lastLoginAt: null,
      passwordUpdatedAt: STAMP_A,
      failedAttempts: 0,
      lockedUntil: null,
    });

    const [write] = calls.updateOne;
    expect(write?.options).toEqual({ upsert: true });
    // 这条断言就是这个测试的理由：`createdAt` 若落在 `$set` 里，每次改密码都会把它推到"现在"。
    expect(write?.update).toMatchObject({
      $set: { passwordHash: HASH_FIXTURE, role: "operator" },
      $setOnInsert: { username: "ops", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(JSON.stringify(write?.update)).not.toContain('"$set":{"createdAt"');
  });

  it("countUsers 走 countDocuments 而不是把用户拉回内存数长度", async () => {
    const { db } = createFakeDb({ users: [{}, {}, {}] });
    persistence.__setDbForTests(db);
    await expect(persistence.countUsers()).resolves.toBe(3);
  });

  it("setPasswordAndInvalidate 写新哈希并 $inc tokenVersion —— 改密即失效已签发 token", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.setPasswordAndInvalidate(
      "ops",
      HASH_FIXTURE_NEXT,
      "2026-07-01T00:00:00.000Z",
    );

    const [write] = calls.updateOne;
    expect(write?.filter).toEqual({ username: "ops" });
    expect(write?.update).toMatchObject({
      $set: {
        passwordHash: HASH_FIXTURE_NEXT,
        passwordUpdatedAt: STAMP_B,
        updatedAt: "2026-07-01T00:00:00.000Z",
      },
      $inc: { tokenVersion: 1 },
    });
  });

  it("bumpTokenVersion 只 $inc tokenVersion（登出全设备失效）", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.bumpTokenVersion("ops", "2026-07-01T00:00:00.000Z");

    const [write] = calls.updateOne;
    expect(write?.filter).toEqual({ username: "ops" });
    expect(write?.update).toMatchObject({ $inc: { tokenVersion: 1 } });
  });

  it("recordLogin 只写 lastLoginAt，不碰其它字段", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.recordLogin("ops", "2026-07-01T00:00:00.000Z");

    const [write] = calls.updateOne;
    expect(write?.update).toEqual({ $set: { lastLoginAt: "2026-07-01T00:00:00.000Z" } });
  });

  it("listUsers 投影掉 _id 并按 username 升序", async () => {
    const { db, calls } = createFakeDb({ users: [{ username: "a" }, { username: "b" }] });
    persistence.__setDbForTests(db);

    await persistence.listUsers();

    const [query] = calls.find;
    expect(query?.collection).toBe("users");
    expect(query?.options).toEqual({ projection: { _id: 0 } });
    expect(query?.sort).toEqual({ username: 1 });
  });

  it("createUser 走 insertOne", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    const created = await persistence.createUser({
      username: "ops",
      passwordHash: HASH_FIXTURE,
      role: "operator",
      createdAt: STAMP_A,
      updatedAt: STAMP_A,
      enabled: true,
      tokenVersion: 0,
      displayName: "ops",
      email: null,
      phone: null,
      lastLoginAt: null,
      passwordUpdatedAt: STAMP_A,
      failedAttempts: 0,
      lockedUntil: null,
    });

    expect(created).toBe(true);
    expect(calls.insertOne[0]?.collection).toBe("users");
  });

  it("updateUserFields 只 $set 传入字段 + updatedAt", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.updateUserFields("ops", { role: "viewer", enabled: false }, STAMP_B);

    const [write] = calls.updateOne;
    expect(write?.filter).toEqual({ username: "ops" });
    expect(write?.update).toEqual({
      $set: { role: "viewer", enabled: false, updatedAt: STAMP_B },
    });
  });

  it("deleteUser 走 deleteOne，返回是否删到", async () => {
    const { db, calls } = createFakeDb({ users: [{ username: "ops" }] });
    persistence.__setDbForTests(db);

    await expect(persistence.deleteUser("ops")).resolves.toBe(true);
    expect(calls.deleteOne[0]).toEqual({ collection: "users", filter: { username: "ops" } });
  });

  it("countEnabledAdmins 用 role+enabled 过滤", async () => {
    const { db, calls } = createFakeDb({ users: [{}, {}] });
    persistence.__setDbForTests(db);

    await persistence.countEnabledAdmins();

    expect(calls.countDocuments[0]).toEqual({
      collection: "users",
      filter: { role: "admin", enabled: true },
    });
  });
});

describe("audit_log", () => {
  const entry = {
    ts: new Date("2026-07-01T00:00:00.000Z"),
    actor: "root",
    action: "user_delete" as const,
    target: "bob",
    outcome: "success" as const,
  };

  it("appendAudit 走 insertOne", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.appendAudit(entry);
    expect(calls.insertOne[0]?.collection).toBe("audit_log");
  });

  it("appendAudit 写失败被吞掉，不冒泡（审计是旁路，不能反噬主流程）", async () => {
    const { db } = createFakeDb({}, { insertOne: true });
    persistence.__setDbForTests(db);
    // insertOne rejects, but appendAudit must resolve.
    await expect(persistence.appendAudit(entry)).resolves.toBeUndefined();
  });

  it("queryAudit 过滤 actor/action/时间，按 ts 倒序、投影掉 _id", async () => {
    const { db, calls } = createFakeDb({ audit_log: [{ actor: "root", action: "login" }] });
    persistence.__setDbForTests(db);

    await persistence.queryAudit({
      actor: "root",
      action: "login",
      from: "2026-01-01T00:00:00Z",
      to: "2026-02-01T00:00:00Z",
    });

    const [query] = calls.find;
    expect(query?.collection).toBe("audit_log");
    expect(query?.options).toEqual({ projection: { _id: 0 } });
    expect(query?.sort).toEqual({ ts: -1 });
    expect(query?.filter).toMatchObject({
      actor: "root",
      action: "login",
      ts: { $gte: anyDate, $lte: anyDate },
    });
  });

  it("queryAudit 无过滤时不写任何条件", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);
    await persistence.queryAudit({});
    expect(calls.find[0]?.filter).toEqual({});
  });
});

describe("notify_log（Phase 16D-1）", () => {
  const record = {
    ts: "2026-07-01T00:00:00.000Z",
    eventKey: "agv-a:agv-a-offline",
    channelId: "ops-webhook",
    channelType: "webhook" as const,
    deviceId: "agv-a",
    alertId: "agv-a-offline",
    severity: "critical",
    title: "设备离线",
    status: "failed" as const,
    httpStatus: 503,
    attempts: 3,
    latencyMs: 42,
    error: "HTTP 503",
  };

  it("appendNotify 走 insertOne，并补一个 expireAt Date 给 TTL", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.appendNotify(record);
    const [insert] = calls.insertOne;
    expect(insert?.collection).toBe("notify_log");
    expect((insert?.doc as { expireAt: unknown }).expireAt).toBeInstanceOf(Date);
  });

  it("appendNotify 写失败被吞掉，不冒泡（发送记录是旁路，不能反噬 fire-and-forget）", async () => {
    const { db } = createFakeDb({}, { insertOne: true });
    persistence.__setDbForTests(db);
    await expect(persistence.appendNotify(record)).resolves.toBeUndefined();
  });

  it("queryNotify 过滤 device/channel/status/时间，按 ts 倒序、投影掉 _id 与 expireAt", async () => {
    const { db, calls } = createFakeDb({ notify_log: [record] });
    persistence.__setDbForTests(db);

    await persistence.queryNotify({
      deviceId: "agv-a",
      channelId: "ops-webhook",
      status: "failed",
      from: "2026-01-01T00:00:00Z",
      to: "2026-08-01T00:00:00Z",
    });

    const [query] = calls.find;
    expect(query?.collection).toBe("notify_log");
    expect(query?.options).toEqual({ projection: { _id: 0, expireAt: 0 } });
    expect(query?.sort).toEqual({ ts: -1 });
    expect(query?.filter).toMatchObject({
      deviceId: "agv-a",
      channelId: "ops-webhook",
      status: "failed",
      ts: { $gte: anyString, $lte: anyString },
    });
  });

  it("无 Mongo 时落内存环并可回查、按过滤命中", async () => {
    const memoryOnly = new Persistence();
    await memoryOnly.appendNotify(record);
    await memoryOnly.appendNotify({ ...record, channelId: "wecom-bot", status: "sent" });

    expect(await memoryOnly.queryNotify({})).toHaveLength(2);
    expect(await memoryOnly.queryNotify({ status: "sent" })).toHaveLength(1);
    expect(await memoryOnly.queryNotify({ channelId: "ops-webhook" })).toHaveLength(1);
  });
});

describe("restoreLatestDevices", () => {
  it("两个轴都有界：时间窗 + maxDevices，且按 stamp 倒序", async () => {
    const { db, calls } = createFakeDb({
      device_latest: [{ deviceId: "agv-a", stamp: "2026-01-01T00:00:00.000Z" }],
    });
    persistence.__setDbForTests(db);

    const devices = await persistence.restoreLatestDevices();

    const [query] = calls.find;
    expect(query?.collection).toBe("device_latest");
    expect(query?.sort).toEqual({ stamp: -1 });
    expect(query?.limit).toBe(config.maxDevices);
    // 无界的 `find({})` 会在每次重启时把 device_latest 历史累积的全部行读回内存 ——
    // 正是驱逐机制要防的那种增长，只不过在重启时重新装上。
    expect(query?.filter).toMatchObject({ stamp: { $gte: anyString } });

    // 缺字段的旧行补齐成可用形状，而不是把 undefined 带进快照。
    expect(devices[0]).toMatchObject({ alerts: [], extra: {}, tags: [] });
  });
});

describe("遥测写入与缓冲", () => {
  it("写成功后顺带把积压的缓冲一起冲出去", async () => {
    const { db, calls } = createFakeDb();
    // 先在没有 db 的状态下攒两条，再接上 db 写第三条。
    await persistence.writeTelemetry(snapshot("agv-a"));
    await persistence.writeTelemetry(snapshot("agv-a"));
    expect(persistence.telemetryBufferStats().pending).toBe(2);

    persistence.__setDbForTests(db);
    await persistence.writeTelemetry(snapshot("agv-a"));

    expect(calls.insertOne).toHaveLength(1);
    expect(calls.insertMany[0]?.docs).toHaveLength(2);
    expect(persistence.telemetryBufferStats().pending).toBe(0);
  });

  it("写失败时把这一条放回缓冲，而不是丢掉", async () => {
    const { db } = createFakeDb({}, { insertOne: true });
    persistence.__setDbForTests(db);

    await persistence.writeTelemetry(snapshot("agv-a"));

    // 「监控平台唯一不能默默承受的损失」—— 所以失败路径必须留痕，而不是 return。
    expect(persistence.telemetryBufferStats().pending).toBe(1);
    expect(persistence.telemetryBufferStats().dropped).toBe(0);
  });

  it("flush 失败时文档回到缓冲，且仍受 mongoBufferLimit 约束", async () => {
    const { db, calls } = createFakeDb({}, { insertMany: true });
    await persistence.writeTelemetry(snapshot("agv-a"));
    persistence.__setDbForTests(db);

    await persistence.flushTelemetry();

    expect(calls.insertMany[0]?.options).toEqual({ ordered: false });
    // 关键行为：一次失败的 flush 不能吞掉它刚取出的那批。
    expect(persistence.telemetryBufferStats().pending).toBe(1);
  });

  it("空缓冲时不发请求", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);
    await persistence.flushTelemetry();
    expect(calls.insertMany).toHaveLength(0);
  });
});

describe("writeLatestSnapshot", () => {
  it("upsert 到 device_latest", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.writeLatestSnapshot(snapshot("agv-a"));

    expect(calls.updateOne[0]).toMatchObject({
      collection: "device_latest",
      filter: { deviceId: "agv-a" },
      options: { upsert: true },
    });
  });

  it("驱动报错只记日志，不把异常抛给调用方", async () => {
    const { db } = createFakeDb({}, { updateOne: true });
    persistence.__setDbForTests(db);
    // 快照写入在摄取路径上：一次 Mongo 抖动不该让这一帧的处理整体失败。
    await expect(persistence.writeLatestSnapshot(snapshot("agv-a"))).resolves.toBeUndefined();
  });
});

describe("upsertAlerts", () => {
  it("清除的判据是「不在本次活跃集合里」，用 $nin 一次说清", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.upsertAlerts("agv-a", [alert("low-soc"), alert("offline")]);

    expect(calls.updateOne.map((call) => call.filter)).toEqual([
      { eventKey: "agv-a:low-soc" },
      { eventKey: "agv-a:offline" },
    ]);

    // 这条是整个方法的契约：本次没报的旧告警要被标成已清除，而判据必须是这两个 key 的补集 ——
    // 写错成 `$in` 或漏掉 `deviceId` 都会让别的车的告警被顺手清掉。
    const [clear] = calls.updateMany;
    expect(clear?.filter).toEqual({
      deviceId: "agv-a",
      active: true,
      eventKey: { $nin: ["agv-a:low-soc", "agv-a:offline"] },
    });
    expect(clear?.update).toMatchObject({ $set: { active: false } });
  });

  it("firstSeenAt 只在插入时写 —— 反复上报同一条不会刷新它", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.upsertAlerts("agv-a", [alert("low-soc")]);

    const update = calls.updateOne[0]?.update as Record<string, Record<string, unknown>>;
    expect(update.$setOnInsert).toHaveProperty("firstSeenAt");
    expect(update.$set).not.toHaveProperty("firstSeenAt");
    expect(update.$set).toHaveProperty("lastSeenAt");
    // 确认字段只在插入时初始化为 null；re-report 的 $set 不碰它们，确认得以保留（Phase 16A）。
    expect(update.$setOnInsert).toMatchObject({
      ackedBy: null,
      ackedAt: null,
      comment: null,
    });
    expect(update.$set).not.toHaveProperty("ackedBy");
  });

  it("清除一条告警时一并清掉确认 —— 重新触发是新的一次，应回到未确认（Phase 16A）", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.upsertAlerts("agv-a", [alert("low-soc")]);

    const [clear] = calls.updateMany;
    expect(clear?.update).toMatchObject({
      $set: { active: false, ackedBy: null, ackedAt: null, comment: null },
    });
  });

  it("即使 Mongo 报错，内存里的活跃集合仍然是更新过的", async () => {
    const { db } = createFakeDb({}, { updateOne: true });
    persistence.__setDbForTests(db);

    await persistence.upsertAlerts("agv-a", [alert("low-soc")]);

    // 内存镜像先写、Mongo 后写，所以 /api/alerts 在数据库抖动时仍与实时快照一致。
    persistence.__setDbForTests(null);
    const items = (await persistence.queryAlerts({})) as Array<{ alertId: string }>;
    expect(items.map((item) => item.alertId)).toEqual(["low-soc"]);
  });
});

describe("ackAlert / unackAlert（Phase 16A）", () => {
  it("ack 只命中活跃行，写入确认三字段并返回命中（Mongo 路径）", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    const at = new Date("2026-03-01T08:00:00.000Z");
    const ok = await persistence.ackAlert("agv-a:low-soc", "op-1", "看过了", at);

    expect(ok).toBe(true);
    const [write] = calls.updateOne;
    expect(write?.collection).toBe("alerts");
    // active:true 是契约的一半：不能确认一个已经不再发生的告警。
    expect(write?.filter).toEqual({ eventKey: "agv-a:low-soc", active: true });
    expect(write?.update).toEqual({
      $set: { ackedBy: "op-1", ackedAt: at, comment: "看过了" },
    });
  });

  it("unack 把三字段置回 null（Mongo 路径）", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    const ok = await persistence.unackAlert("agv-a:low-soc");

    expect(ok).toBe(true);
    const [write] = calls.updateOne;
    expect(write?.filter).toEqual({ eventKey: "agv-a:low-soc", active: true });
    expect(write?.update).toEqual({
      $set: { ackedBy: null, ackedAt: null, comment: null },
    });
  });

  it("内存降级路径：命中活跃告警则更新并返回 true，未知 eventKey 返回 false（→ 路由 404）", async () => {
    persistence.__setDbForTests(null);
    // 先让内存里有一条活跃告警。
    await persistence.upsertAlerts("agv-a", [alert("low-soc")]);

    const at = new Date("2026-03-01T08:00:00.000Z");
    expect(await persistence.ackAlert("agv-a:low-soc", "op-1", null, at)).toBe(true);

    const [acked] = (await persistence.queryAlerts({})) as Array<{
      ackedBy: string | null;
      ackedAt: string | null;
    }>;
    expect(acked?.ackedBy).toBe("op-1");
    expect(acked?.ackedAt).toBe(at.toISOString());

    // 未知 key：什么都不改，返回未命中。
    expect(await persistence.ackAlert("agv-a:ghost", "op-1", null, at)).toBe(false);
    expect(await persistence.unackAlert("agv-a:ghost")).toBe(false);

    // unack 把它清回未确认。
    expect(await persistence.unackAlert("agv-a:low-soc")).toBe(true);
    const [cleared] = (await persistence.queryAlerts({})) as Array<{ ackedBy: string | null }>;
    expect(cleared?.ackedBy).toBeNull();
  });

  it("内存降级路径：re-report 保留已存在的确认（与 Mongo 的 $set 不碰确认字段同构）", async () => {
    persistence.__setDbForTests(null);
    await persistence.upsertAlerts("agv-a", [alert("low-soc")]);
    await persistence.ackAlert("agv-a:low-soc", "op-1", null, new Date());

    // 同一条告警再次上报（仍活跃）。
    await persistence.upsertAlerts("agv-a", [alert("low-soc")]);

    const [item] = (await persistence.queryAlerts({})) as Array<{ ackedBy: string | null }>;
    expect(item?.ackedBy).toBe("op-1");
  });
});

describe("查询", () => {
  it("queryHistory 把 limit 夹到 maxHistoryPoints，并按 ts 倒序", async () => {
    const { db, calls } = createFakeDb({ telemetry_ts: [{ ts: new Date() }] });
    persistence.__setDbForTests(db);

    await persistence.queryHistory({
      deviceId: "agv-a",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-02T00:00:00Z",
      limit: config.maxHistoryPoints + 5000,
    });

    const [query] = calls.find;
    expect(query?.collection).toBe("telemetry_ts");
    expect(query?.sort).toEqual({ ts: -1 });
    // 上界钉在配置上：`historyQuerySchema` 只守 HTTP 那条路，而 `HistoryQuery` 是任何
    // 进程内调用方都能自己构造的普通类型，所以上界属于读行的地方。
    expect(query?.limit).toBe(config.maxHistoryPoints);
    expect(query?.filter).toMatchObject({
      "meta.deviceId": "agv-a",
      ts: { $gte: anyDate, $lte: anyDate },
    });
  });

  it("queryHistory 没有时间界时不写 ts 条件", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);
    await persistence.queryHistory({ deviceId: "agv-a" });
    expect(calls.find[0]?.filter).toEqual({ "meta.deviceId": "agv-a" });
  });

  it("queryAlerts 把 status 翻译成 active 布尔，而不是原样当查询字段", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.queryAlerts({ status: "cleared", severity: "critical", deviceId: "agv-a" });
    expect(calls.find[0]?.filter).toEqual({
      severity: "critical",
      deviceId: "agv-a",
      active: false,
    });

    await persistence.queryAlerts({ status: "active" });
    expect(calls.find[1]?.filter).toEqual({ active: true });

    // 无法识别的 status 不该退化成 `active: undefined`（那会匹配不到任何行）。
    await persistence.queryAlerts({ status: "nonsense" });
    expect(calls.find[2]?.filter).toEqual({});
  });

  it("内存镜像里的告警带 clearedAt=null（Phase 16B，与 openapi Alert schema 对齐）", async () => {
    // 内存只存活跃告警，所以 clearedAt 恒为 null；这条钉住接口不再漏这个字段。
    persistence.__setDbForTests(null);
    await persistence.upsertAlerts("agv-a", [alert("low-soc")]);

    const [item] = (await persistence.queryAlerts({})) as Array<{
      clearedAt: string | null;
    }>;
    expect(item).toHaveProperty("clearedAt", null);
  });
});

describe("aggregateAlertStats（Phase 17A 服务端聚合）", () => {
  // 一份 facet 结果替真实 Mongo 作答：fake db 不执行管道，只把它录下来并回放 canned 文档。管道的
  // 形状（纯 builder）与 facet→报表的映射（纯 mapper）各有自己的单测；这里验的是接线——方法把
  // 管道发给 alerts 集合的 aggregate，并把结果喂给 mapper。
  const facet = {
    bySeverity: [
      { _id: "critical", count: 2 },
      { _id: "warning", count: 3 },
      // 未知严重度：mapper 应归到 notice，而不是凭空多一档。
      { _id: "weird", count: 1 },
    ],
    topDevices: [
      { _id: "agv-1", count: 4 },
      { _id: "agv-2", count: 1 },
    ],
    daily: [{ _id: "2026-09-01", count: 5 }],
    totals: [{ _id: null, total: 6, acked: 3 }],
    durations: [{ _id: null, values: [1000, 3000, 2000] }],
  };

  it("把区间管道发给 alerts.aggregate，并把 facet 映射成报表", async () => {
    const { db, calls } = createFakeDb({}, {}, { alerts: [facet] });
    persistence.__setDbForTests(db);

    const report = await persistence.aggregateAlertStats({
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-30T00:00:00Z",
    });

    // 接线：聚合打在 alerts 上；给了边界就有一个按 firstSeenAt 过滤的 $match，随后是 $facet。
    const [call] = calls.aggregate;
    expect(call?.collection).toBe("alerts");
    const pipeline = call?.pipeline as Array<Record<string, unknown>>;
    expect(pipeline[0]).toMatchObject({
      $match: { firstSeenAt: { $gte: anyDate, $lte: anyDate } },
    });
    const facetStage = pipeline.find((stage) => "$facet" in stage)?.$facet as Record<
      string,
      unknown
    >;
    expect(Object.keys(facetStage).sort()).toEqual([
      "bySeverity",
      "daily",
      "durations",
      "topDevices",
      "totals",
    ]);

    // 映射：未知严重度并入 notice，Top-N 只留 deviceId，确认率零除保护，时长中位数取对。
    expect(report.available).toBe(true);
    expect(report.total).toBe(6);
    expect(report.bySeverity).toEqual({ critical: 2, warning: 3, notice: 1 });
    expect(report.topDevices).toEqual([
      { deviceId: "agv-1", count: 4 },
      { deviceId: "agv-2", count: 1 },
    ]);
    expect(report.daily).toEqual([{ day: "2026-09-01", count: 5 }]);
    expect(report.ackRate).toBe(0.5);
    expect(report.duration).toEqual({ count: 3, meanMs: 2000, p50Ms: 2000 });
  });

  it("没给边界时不加 $match，直接 $facet 扫 TTL 窗口内全部", async () => {
    const { db, calls } = createFakeDb({}, {}, { alerts: [facet] });
    persistence.__setDbForTests(db);

    await persistence.aggregateAlertStats({});

    const pipeline = calls.aggregate[0]?.pipeline as Array<Record<string, unknown>>;
    expect(pipeline).toHaveLength(1);
    expect(pipeline[0]).toHaveProperty("$facet");
  });

  it("无 Mongo 时返回 available:false 的诚实空态，不谎报'零告警'", async () => {
    persistence.__setDbForTests(null);
    const report = await persistence.aggregateAlertStats({});
    expect(report.available).toBe(false);
    expect(report.total).toBe(0);
    expect(report.bySeverity).toEqual({ critical: 0, warning: 0, notice: 0 });
    expect(report.ackRate).toBeNull();
    expect(report.duration).toEqual({ count: 0, meanMs: null, p50Ms: null });
  });
});

describe("aggregateAvailability（Phase 17A-2 可用率/电量时序）", () => {
  const rows = [
    {
      _id: { deviceId: "agv-1", bucketStart: new Date("2026-09-01T00:00:00Z") },
      onlineSamples: 9,
      totalSamples: 10,
      socMean: 82.5,
      socMin: 70,
    },
  ];

  it("把设备+区间管道发给 telemetry_ts.aggregate，并把行映射成每台一条序列", async () => {
    const { db, calls } = createFakeDb({}, {}, { telemetry_ts: rows });
    persistence.__setDbForTests(db);

    const report = await persistence.aggregateAvailability({
      deviceId: "agv-1",
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-02T00:00:00Z",
      bucket: "hour",
    });

    const [call] = calls.aggregate;
    expect(call?.collection).toBe("telemetry_ts");
    const pipeline = call?.pipeline as Array<Record<string, unknown>>;
    expect(pipeline[0]).toMatchObject({
      $match: { "meta.deviceId": "agv-1", ts: { $gte: anyDate, $lte: anyDate } },
    });

    expect(report.available).toBe(true);
    expect(report.bucket).toBe("hour");
    expect(report.devices).toEqual([
      {
        deviceId: "agv-1",
        buckets: [
          {
            bucketStart: "2026-09-01T00:00:00.000Z",
            onlineSamples: 9,
            totalSamples: 10,
            onlineRatio: 0.9,
            socMean: 82.5,
            socMin: 70,
          },
        ],
      },
    ]);
  });

  it("无 Mongo 时返回 available:false 的诚实空态，并回显请求的桶粒度", async () => {
    persistence.__setDbForTests(null);
    const report = await persistence.aggregateAvailability({ bucket: "day" });
    expect(report).toEqual({ bucket: "day", devices: [], available: false });
  });
});

describe("登录锁定字段", () => {
  it("setLoginFailure 一次写 failedAttempts + lockedUntil，二者不分家", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.setLoginFailure("ops", 5, STAMP_B, STAMP_A);

    const [write] = calls.updateOne;
    expect(write?.filter).toEqual({ username: "ops" });
    expect(write?.update).toEqual({
      $set: { failedAttempts: 5, lockedUntil: STAMP_B, updatedAt: STAMP_A },
    });
  });

  it("clearLoginFailures 归零并清空锁", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.clearLoginFailures("ops", STAMP_A);

    expect(calls.updateOne[0]?.update).toEqual({
      $set: { failedAttempts: 0, lockedUntil: null, updatedAt: STAMP_A },
    });
  });
});

describe("sessions 集合", () => {
  const session = () => ({
    sessionId: "sid-1",
    username: "ops",
    createdAt: STAMP_A,
    lastSeenAt: STAMP_A,
    userAgent: "ua",
    ip: "127.0.0.1",
    expiresAt: new Date("2026-02-01T00:00:00.000Z"),
  });

  it("createSession 以 sessionId 为键 upsert", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.createSession(session());

    expect(calls.updateOne[0]).toMatchObject({
      collection: "sessions",
      filter: { sessionId: "sid-1" },
      options: { upsert: true },
    });
  });

  it("touchSession 只顺延 lastSeenAt 与 expiresAt", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    const nextExpiry = new Date("2026-03-01T00:00:00.000Z");
    await persistence.touchSession("sid-1", STAMP_B, nextExpiry);

    const [write] = calls.updateOne;
    expect(write?.filter).toEqual({ sessionId: "sid-1" });
    expect(write?.update).toEqual({ $set: { lastSeenAt: STAMP_B, expiresAt: nextExpiry } });
  });

  it("isSessionActive 按 sessionId + username 计数（别的车主的会话不算数）", async () => {
    const { db, calls } = createFakeDb({ sessions: [{}] });
    persistence.__setDbForTests(db);

    await expect(persistence.isSessionActive("ops", "sid-1")).resolves.toBe(true);
    expect(calls.countDocuments[0]).toEqual({
      collection: "sessions",
      filter: { sessionId: "sid-1", username: "ops" },
    });
  });

  it("listSessions 投影掉 _id、按 createdAt 倒序", async () => {
    const { db, calls } = createFakeDb({ sessions: [session()] });
    persistence.__setDbForTests(db);

    await persistence.listSessions("ops");

    const [query] = calls.find;
    expect(query?.collection).toBe("sessions");
    expect(query?.filter).toEqual({ username: "ops" });
    expect(query?.options).toEqual({ projection: { _id: 0 } });
    expect(query?.sort).toEqual({ createdAt: -1 });
  });

  it("deleteSession 用 sessionId + username 双条件（只能删自己的）", async () => {
    const { db, calls } = createFakeDb({ sessions: [session()] });
    persistence.__setDbForTests(db);

    await expect(persistence.deleteSession("ops", "sid-1")).resolves.toBe(true);
    expect(calls.deleteOne[0]).toEqual({
      collection: "sessions",
      filter: { sessionId: "sid-1", username: "ops" },
    });
  });

  it("deleteAllSessions 用 username 一把清空（强制下线 / 全设备失效）", async () => {
    const { db, calls } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.deleteAllSessions("ops");
    expect(calls.deleteMany[0]).toEqual({ collection: "sessions", filter: { username: "ops" } });
  });
});
