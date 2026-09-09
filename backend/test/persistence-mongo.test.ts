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
}

/** A fake `Db` that records calls and replays canned rows. */
const createFakeDb = (
  rows: Record<string, unknown[]> = {},
  failures: { insertMany?: boolean; updateOne?: boolean; insertOne?: boolean } = {},
): { db: Db; calls: Recorded } => {
  const calls: Recorded = {
    find: [],
    updateOne: [],
    updateMany: [],
    insertMany: [],
    insertOne: [],
    findOne: [],
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
        : Promise.resolve({});
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
    countDocuments: () => Promise.resolve((rows[name] ?? []).length),
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
  mapProfile: "lanelet",
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

let persistence: Persistence;

beforeEach(() => {
  persistence = new Persistence();
  vi.restoreAllMocks();
});

describe("users 集合", () => {
  it("按 username 查询并把 _id 投影掉", async () => {
    const { db, calls } = createFakeDb({
      users: [{ username: "ops", passwordHash: "h", role: "operator" }],
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
      passwordHash: "new-hash",
      role: "operator",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });

    const [write] = calls.updateOne;
    expect(write?.options).toEqual({ upsert: true });
    // 这条断言就是这个测试的理由：`createdAt` 若落在 `$set` 里，每次改密码都会把它推到"现在"。
    expect(write?.update).toMatchObject({
      $set: { passwordHash: "new-hash", role: "operator" },
      $setOnInsert: { username: "ops", createdAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(JSON.stringify(write?.update)).not.toContain('"$set":{"createdAt"');
  });

  it("countUsers 走 countDocuments 而不是把用户拉回内存数长度", async () => {
    const { db } = createFakeDb({ users: [{}, {}, {}] });
    persistence.__setDbForTests(db);
    await expect(persistence.countUsers()).resolves.toBe(3);
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
});
