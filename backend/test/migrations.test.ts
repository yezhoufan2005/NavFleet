import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Db } from "mongodb";
import { runMigrations } from "../src/migrations/runner";
import { assertMigrationsWellFormed, migrations } from "../src/migrations/index";
import { MigrationError, MIGRATIONS_COLLECTION, type Migration } from "../src/migrations/types";
import { Persistence } from "../src/persistence";
import { moduleLogger } from "../src/logger";

/**
 * The migration runner over a fake `Db`. What can go wrong in a runner is the **shape of the
 * decisions** — does it start from the right version, does baselining recognise an existing
 * database, does a failed `up` stop the run and leave the later markers unwritten — none of
 * which a real mongod would check more strictly. So the fake stores the `schema_migrations`
 * markers for real (idempotency has to be observed, not mocked) and answers `listCollections`
 * from a declared set. The migration list is injected per case (the runner accepts it as a
 * parameter) so tests never depend on how many real migrations happen to exist.
 */

interface FakeCursor<T> {
  sort: (spec: Record<string, 1 | -1>) => FakeCursor<T>;
  limit: (n: number) => FakeCursor<T>;
  toArray: () => Promise<T[]>;
}

const cursorOver = <T>(rows: T[]): FakeCursor<T> => {
  let current = [...rows];
  const cursor: FakeCursor<T> = {
    sort: (spec) => {
      const [entry] = Object.entries(spec);
      if (entry) {
        const [key, dir] = entry;
        current.sort((a, b) => {
          const av = (a as Record<string, number>)[key] ?? 0;
          const bv = (b as Record<string, number>)[key] ?? 0;
          return (av === bv ? 0 : av < bv ? -1 : 1) * (dir as number);
        });
      }
      return cursor;
    },
    limit: (n) => {
      current = current.slice(0, n);
      return cursor;
    },
    toArray: () => Promise.resolve(current),
  };
  return cursor;
};

interface MarkerDoc {
  version: number;
  name: string;
  appliedAt: string;
}

/** A fake `Db` that persists `schema_migrations` markers and reports a declared collection set. */
const createFakeDb = (
  collectionNames: string[] = [],
): {
  db: Db;
  markers: MarkerDoc[];
  upsertCount: () => number;
  otherUpdates: Array<{ collection: string; filter: unknown; update: unknown }>;
} => {
  const markers: MarkerDoc[] = [];
  const otherUpdates: Array<{ collection: string; filter: unknown; update: unknown }> = [];
  let upserts = 0;
  const names = new Set(collectionNames);

  const migrationsCollection = {
    find: () => cursorOver(markers),
    updateOne: (filter: { version: number }, update: { $set: MarkerDoc }, _options?: unknown) => {
      upserts += 1;
      const existing = markers.find((doc) => doc.version === filter.version);
      if (existing) {
        Object.assign(existing, update.$set);
      } else {
        markers.push({ ...update.$set });
      }
      return Promise.resolve({});
    },
  };

  const db = {
    collection: (name: string) => {
      if (name === MIGRATIONS_COLLECTION) {
        return migrationsCollection;
      }
      // Other collections (e.g. `users` for migration v2) record their writes so a migration's
      // query shape can be asserted; the runner itself only orchestrates.
      return {
        updateMany: (filter: unknown, update: unknown) => {
          otherUpdates.push({ collection: name, filter, update });
          return Promise.resolve({});
        },
      };
    },
    listCollections: (_filter?: unknown, _options?: unknown) => ({
      toArray: () => Promise.resolve([...names].map((name) => ({ name }))),
    }),
  } as unknown as Db;

  return { db, markers, upsertCount: () => upserts, otherUpdates };
};

const log = moduleLogger("test-migrations");

const listOf = (recorder: number[]): Migration[] => [
  {
    version: 1,
    name: "one",
    up: async () => {
      recorder.push(1);
    },
  },
  {
    version: 2,
    name: "two",
    up: async () => {
      recorder.push(2);
    },
  },
];

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("migration 列表自身", () => {
  it("真实导出的列表是良构的（版本从 1 连续无缺口）", () => {
    expect(() => assertMigrationsWellFormed(migrations)).not.toThrow();
    expect(migrations[0]?.version).toBe(1);
  });

  it("v2 只补缺失字段：过滤 tokenVersion 不存在的行，用 $ifNull 派生默认值（幂等）", async () => {
    const v2 = migrations.find((migration) => migration.version === 2);
    expect(v2).toBeDefined();
    const { db, otherUpdates } = createFakeDb();
    await v2!.up(db);

    expect(otherUpdates).toHaveLength(1);
    const [write] = otherUpdates;
    expect(write?.collection).toBe("users");
    // 只碰还没迁过的行 —— 这是幂等的来源。
    expect(write?.filter).toEqual({ tokenVersion: { $exists: false } });
    // 聚合式 $set，用 $ifNull 让默认值能从既有字段派生（displayName←username 等）。
    const pipeline = write?.update as Array<{ $set: Record<string, unknown> }>;
    expect(pipeline[0]?.$set).toMatchObject({
      enabled: { $ifNull: ["$enabled", true] },
      tokenVersion: { $ifNull: ["$tokenVersion", 0] },
      displayName: { $ifNull: ["$displayName", "$username"] },
      passwordUpdatedAt: { $ifNull: ["$passwordUpdatedAt", "$createdAt"] },
    });
  });

  it("v3 只补锁定字段：过滤 failedAttempts 不存在的行，用 $ifNull 幂等 backfill", async () => {
    const v3 = migrations.find((migration) => migration.version === 3);
    expect(v3).toBeDefined();
    const { db, otherUpdates } = createFakeDb();
    await v3!.up(db);

    expect(otherUpdates).toHaveLength(1);
    const [write] = otherUpdates;
    expect(write?.collection).toBe("users");
    // 只碰还没迁过的行 —— 幂等的来源，与 v2 同型。
    expect(write?.filter).toEqual({ failedAttempts: { $exists: false } });
    const pipeline = write?.update as Array<{ $set: Record<string, unknown> }>;
    expect(pipeline[0]?.$set).toMatchObject({
      failedAttempts: { $ifNull: ["$failedAttempts", 0] },
      lockedUntil: { $ifNull: ["$lockedUntil", null] },
    });
  });

  it("v4 只补告警确认字段：过滤 ackedBy 不存在的行，用 $ifNull 幂等 backfill（Phase 16A）", async () => {
    const v4 = migrations.find((migration) => migration.version === 4);
    expect(v4).toBeDefined();
    const { db, otherUpdates } = createFakeDb();
    await v4!.up(db);

    expect(otherUpdates).toHaveLength(1);
    const [write] = otherUpdates;
    // 告警集合，不是 users —— 这条迁的是 alerts。
    expect(write?.collection).toBe("alerts");
    // 只碰还没迁过的行 —— 幂等的来源，与 v2/v3 同型。
    expect(write?.filter).toEqual({ ackedBy: { $exists: false } });
    const pipeline = write?.update as Array<{ $set: Record<string, unknown> }>;
    expect(pipeline[0]?.$set).toMatchObject({
      ackedBy: { $ifNull: ["$ackedBy", null] },
      ackedAt: { $ifNull: ["$ackedAt", null] },
      comment: { $ifNull: ["$comment", null] },
    });
  });

  it("版本有缺口时在加载期就抛错，而不是运行时静默跳过", () => {
    expect(() =>
      assertMigrationsWellFormed([
        { version: 1, name: "a", up: () => Promise.resolve() },
        { version: 3, name: "c", up: () => Promise.resolve() },
      ]),
    ).toThrow(/gap-free/);
  });
});

describe("runMigrations —— 全新空库", () => {
  it("从 0 跑到最新，标记按顺序写全", async () => {
    const applied: number[] = [];
    const { db, markers } = createFakeDb();

    const version = await runMigrations(db, log, listOf(applied));

    expect(version).toBe(2);
    expect(applied).toEqual([1, 2]);
    expect(markers.map((m) => m.version)).toEqual([1, 2]);
  });
});

describe("runMigrations —— 已有集合、无版本标记（1.1.0 老库）", () => {
  it("基线到第一个版本，且不重跑它的 up", async () => {
    const applied: number[] = [];
    const { db, markers } = createFakeDb(["alerts"]);

    // 只给一条迁移：老库应被基线成 version 1，而 up 不执行。
    const version = await runMigrations(db, log, [
      {
        version: 1,
        name: "baseline",
        up: async () => {
          applied.push(1);
        },
      },
    ]);

    expect(version).toBe(1);
    expect(applied).toEqual([]); // 基线不跑 up
    expect(markers.map((m) => m.version)).toEqual([1]);
  });

  it("老库上仍会应用基线之后的新迁移", async () => {
    const applied: number[] = [];
    const { db } = createFakeDb(["device_latest"]);

    const version = await runMigrations(db, log, listOf(applied));

    expect(version).toBe(2);
    // 基线跳过 v1 的 up，但 v2 是真正的结构变更，必须跑。
    expect(applied).toEqual([2]);
  });
});

describe("runMigrations —— 幂等", () => {
  it("已到最新版本时二次运行零写入、零执行", async () => {
    const applied: number[] = [];
    const { db, upsertCount } = createFakeDb();

    await runMigrations(db, log, listOf(applied));
    const afterFirst = upsertCount();

    const recorderSecond: number[] = [];
    const version = await runMigrations(db, log, listOf(recorderSecond));

    expect(version).toBe(2);
    expect(recorderSecond).toEqual([]); // 不重跑
    expect(upsertCount()).toBe(afterFirst); // 不重复写标记
  });
});

describe("runMigrations —— 失败", () => {
  it("某条 up 抛错 → 抛 MigrationError，后续迁移不执行，已成功的标记保留", async () => {
    const applied: number[] = [];
    const { db, markers } = createFakeDb();
    const list: Migration[] = [
      {
        version: 1,
        name: "ok",
        up: async () => {
          applied.push(1);
        },
      },
      {
        version: 2,
        name: "boom",
        up: () => Promise.reject(new Error("index build failed")),
      },
      {
        version: 3,
        name: "never",
        up: async () => {
          applied.push(3);
        },
      },
    ];

    await expect(runMigrations(db, log, list)).rejects.toBeInstanceOf(MigrationError);

    // v1 成功并留痕；v2 失败中断；v3 从不执行也从不留痕。
    expect(applied).toEqual([1]);
    expect(markers.map((m) => m.version)).toEqual([1]);
  });

  it("MigrationError 带上出错的版本与名字，供组合根记录", async () => {
    const { db } = createFakeDb();
    const list: Migration[] = [
      { version: 1, name: "explode", up: () => Promise.reject(new Error("nope")) },
    ];

    await runMigrations(db, log, list).catch((error: unknown) => {
      expect(error).toBeInstanceOf(MigrationError);
      const migrationError = error as MigrationError;
      expect(migrationError.version).toBe(1);
      expect(migrationError.migrationName).toBe("explode");
      expect(migrationError.message).toContain("nope");
    });
    expect.assertions(4);
  });
});

describe("Persistence.migrate 集成", () => {
  it("db 为 null 时是 no-op，migrationError 保持 null（降级路径）", async () => {
    const persistence = new Persistence();
    persistence.__setDbForTests(null);

    await expect(persistence.migrate()).resolves.toBeUndefined();
    expect(persistence.migrationError).toBeNull();
  });

  it("有 db 时应用真实迁移，且二次调用被 migrationsApplied 短路", async () => {
    const persistence = new Persistence();
    const { db, upsertCount } = createFakeDb();
    persistence.__setDbForTests(db);

    await persistence.migrate();
    const afterFirst = upsertCount();
    expect(afterFirst).toBeGreaterThan(0); // 真实 baseline 迁移写了标记
    expect(persistence.migrationError).toBeNull();

    await persistence.migrate();
    expect(upsertCount()).toBe(afterFirst); // 不重复应用
  });

  it("迁移出错 → 记到 migrationError 且上抛（组合根据此拒绝启动）", async () => {
    const persistence = new Persistence();
    const { db } = createFakeDb();
    persistence.__setDbForTests(db);

    const failing: Migration[] = [
      { version: 1, name: "boom", up: () => Promise.reject(new Error("index build failed")) },
    ];

    await expect(persistence.migrate(failing)).rejects.toBeInstanceOf(MigrationError);
    expect(persistence.migrationError).toBeInstanceOf(MigrationError);
    expect(persistence.migrationError?.version).toBe(1);
  });
});
