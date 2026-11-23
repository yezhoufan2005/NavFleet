import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CheckpointCorrupt,
  checkpointPath,
  readCheckpoint,
  writeCheckpoint,
  type Checkpoint,
} from "../sim/fleet";

/**
 * The simulator's checkpoint. A Docker VM stopped between the rename and the data reaching disk
 * left an empty `checkpoint.json`; it was read as "no checkpoint", so catch-up refused with a
 * message about the database already holding history — the wrong cause. A missing file is still
 * "no checkpoint"; a present but unusable one is now reported as corrupt.
 */
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-checkpoint-"));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const sample: Checkpoint = { version: 1, t: 1_700_000_000_000, states: [] };

describe("readCheckpoint", () => {
  it("returns null when there is no checkpoint file", () => {
    expect(readCheckpoint(stateDir)).toBeNull();
  });

  it("reports an empty file as corrupt rather than as no checkpoint", () => {
    fs.writeFileSync(checkpointPath(stateDir), "");
    expect(() => readCheckpoint(stateDir)).toThrow(CheckpointCorrupt);
    expect(() => readCheckpoint(stateDir)).toThrow(/is empty/);
  });

  it("reports truncated JSON as corrupt", () => {
    fs.writeFileSync(checkpointPath(stateDir), '{"version":1,"t":17');
    expect(() => readCheckpoint(stateDir)).toThrow(/not valid JSON/);
  });

  it("reports a file of another format as corrupt", () => {
    fs.writeFileSync(checkpointPath(stateDir), JSON.stringify({ version: 2, states: [] }));
    expect(() => readCheckpoint(stateDir)).toThrow(/not a version-1 checkpoint/);
  });
});

describe("writeCheckpoint", () => {
  it("round-trips and leaves no temporary file behind", () => {
    writeCheckpoint(stateDir, sample);
    expect(readCheckpoint(stateDir)).toEqual(sample);
    expect(fs.readdirSync(stateDir)).toEqual(["checkpoint.json"]);
  });

  it("replaces the previous checkpoint", () => {
    writeCheckpoint(stateDir, sample);
    writeCheckpoint(stateDir, { ...sample, t: sample.t + 1000 });
    expect(readCheckpoint(stateDir)?.t).toBe(sample.t + 1000);
  });
});
