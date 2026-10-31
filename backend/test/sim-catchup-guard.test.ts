import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CatchUpRefused, catchUp } from "../sim/catchup";

/**
 * A first catch-up (no checkpoint) into a database that already holds history. Only telemetry
 * could be matched against what was stored, so messages, acknowledgements, send records and
 * shift logins were written a second time from another timeline and the reports counted the
 * window twice. It now refuses before writing anything.
 *
 * `vi.mock` is hoisted above the imports, so the module under test sees the stubs.
 */
const { stored, writes } = vi.hoisted(() => ({ stored: { frames: 0 }, writes: { inserts: 0 } }));

vi.mock("mongodb", () => ({
  MongoClient: {
    connect: vi.fn(() =>
      Promise.resolve({
        db: () => ({
          collection: () => ({ estimatedDocumentCount: () => Promise.resolve(stored.frames) }),
        }),
        close: () => Promise.resolve(),
      }),
    ),
  },
}));

vi.mock("../src/persistence", () => ({
  Persistence: class {
    connect(): Promise<void> {
      return Promise.resolve();
    }
    isMongoConnected(): boolean {
      return true;
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
    rollupTelemetry(): Promise<number> {
      writes.inserts += 1;
      return Promise.resolve(0);
    }
  },
}));

describe("a first catch-up into a database that already holds history", () => {
  it("refuses, and leaves no checkpoint behind", async () => {
    stored.frames = 1_313_927;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-guard-"));
    try {
      await expect(
        catchUp({ configRoot: path.resolve(__dirname, "../../config-runtime"), stateDir }),
      ).rejects.toBeInstanceOf(CatchUpRefused);
      expect(fs.existsSync(path.join(stateDir, "checkpoint.json"))).toBe(false);
      expect(writes.inserts).toBe(0);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
