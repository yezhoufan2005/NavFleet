#!/usr/bin/env node
/**
 * Generates the 二号冷库 backdrop: an occupancy grid in ROS `map_server` conventions — 8-bit
 * greyscale, 254 free, 0 occupied, 205 unknown, one pixel per 0.05 m — the kind of PNG a SLAM run
 * exports. The demo ships it as the one raster scene that is not an SVG floor plan.
 *
 *   node scripts/demo-assets/cold-store-map.mjs
 *
 * Writes config-runtime/scene-maps/cold-store/cold-store.png. Deterministic (no Math.random): the
 * scan speckle along the walls comes from a hash of the pixel, so re-running yields the same file.
 *
 * Layout, in map metres from the lower-left corner (the scene's `origin` puts that corner at
 * (-10, -6) in the map frame): outer walls round a 60 × 40 m room with a 4 m door in the west wall
 * (to 一号仓储区), four rows of freezer racks from x 12 to 48, a cold-air unit on the north wall,
 * and the charging bay by the door. The vehicle loop (backend/sim/routes.ts) runs in the aisle
 * round the racks.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "config-runtime/scene-maps/cold-store/cold-store.png");

const RES = 0.05;
const WIDTH = 1200;
const HEIGHT = 800;
const FREE = 254;
const OCCUPIED = 0;
const UNKNOWN = 205;

const grid = new Uint8Array(WIDTH * HEIGHT).fill(UNKNOWN);
/** Pixel column/row of a map-metre coordinate (rows grow downward, map y grows upward). */
const col = (x) => Math.round(x / RES);
const row = (y) => HEIGHT - 1 - Math.round(y / RES);

const fill = (x0, y0, x1, y1, value) => {
  for (let r = row(y1); r <= row(y0); r += 1) {
    for (let c = col(x0); c <= col(x1); c += 1) {
      if (r >= 0 && r < HEIGHT && c >= 0 && c < WIDTH)
        grid[r * WIDTH + c] = value;
    }
  }
};

/** Integer hash → [0, 1): the scan speckle, stable from run to run. */
const hash = (c, r) => {
  let h = (Math.imul(c, 0x9e3779b1) ^ Math.imul(r + 7, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// The room: free inside the walls, unknown beyond them.
fill(0.8, 0.8, 59.2, 39.2, FREE);
// Outer walls, 0.3 m.
fill(0.5, 0.5, 59.5, 0.8, OCCUPIED);
fill(0.5, 39.2, 59.5, 39.5, OCCUPIED);
fill(0.5, 0.5, 0.8, 39.5, OCCUPIED);
fill(59.2, 0.5, 59.5, 39.5, OCCUPIED);
// The door to 一号仓储区 (west wall, y 18–22) and the corridor beyond it the laser saw through.
fill(0.4, 18, 0.9, 22, FREE);
fill(0, 18.4, 0.4, 21.6, FREE);
// Freezer racks: four rows, 36 m long and 2.4 m deep, in twelve 3 m bays — the laser sees the
// uprights and beams, not into the bays, so a bay reads as unknown inside a black frame.
for (const y of [8, 14.4, 20.8, 27.2]) {
  fill(12, y, 48, y + 2.4, OCCUPIED);
  for (let bay = 0; bay < 12; bay += 1) {
    const x = 12 + bay * 3;
    fill(x + 0.15, y + 0.25, x + 2.85, y + 2.15, UNKNOWN);
  }
}
// Cold-air unit on the north wall, and the charging bay's posts by the door.
fill(22, 37.4, 38, 39.2, OCCUPIED);
fill(2.2, 33.2, 2.5, 33.5, OCCUPIED);
fill(2.2, 36.2, 2.5, 36.5, OCCUPIED);
// A pallet stack left in the south-east corner — the kind of clutter a real scan keeps.
fill(52.5, 1.6, 55.3, 3.0, OCCUPIED);

// Scan speckle: the odd stray hit beside a wall, and the odd free cell the laser saw past one.
const next = Uint8Array.from(grid);
for (let r = 1; r < HEIGHT - 1; r += 1) {
  for (let c = 1; c < WIDTH - 1; c += 1) {
    const i = r * WIDTH + c;
    const nearWall =
      grid[i - 1] === OCCUPIED ||
      grid[i + 1] === OCCUPIED ||
      grid[i - WIDTH] === OCCUPIED ||
      grid[i + WIDTH] === OCCUPIED;
    if (!nearWall) continue;
    const roll = hash(c, r);
    if (grid[i] === FREE && roll < 0.035) next[i] = OCCUPIED;
    else if (grid[i] === OCCUPIED && roll < 0.02) next[i] = FREE;
  }
}

// PNG: 8-bit greyscale, filter 0 on every row.
const raw = Buffer.alloc((WIDTH + 1) * HEIGHT);
for (let r = 0; r < HEIGHT; r += 1) {
  raw[r * (WIDTH + 1)] = 0;
  Buffer.from(next.buffer, r * WIDTH, WIDTH).copy(raw, r * (WIDTH + 1) + 1);
}
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
};
const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 0; // colour type: greyscale
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${WIDTH} × ${HEIGHT}, ${png.length} bytes)`);
