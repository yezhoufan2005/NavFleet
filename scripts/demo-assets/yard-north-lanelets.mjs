#!/usr/bin/env node
/**
 * Generates the 北区装卸场 road network: a small Lanelet2 map drawn over the yard's floor plan
 * (yard-north.svg), so the demo has a scene with both a raster backdrop and lanes on top of it.
 *
 *   node scripts/demo-assets/yard-north-lanelets.mjs
 *
 * Writes config-runtime/scene-maps/yard-north-lanes.osm. The lanes, in map metres from the yard's
 * lower-left corner (the floor plan is 144 × 89.28 m at 0.144 m/px):
 *
 * - the one-way loop round the 调度作业区 (anticlockwise, 3.6 m wide) the tugs drive — centreline
 *   (82, 22) → (132, 22) → (132, 70) → (82, 70), the hand-authored loop in backend/sim/routes.ts;
 * - three two-way spurs from the loop's west side to dock doors B1–B3;
 * - the two-way access road from the loop's south side to the gate on the campus road.
 *
 * Nodes are latitude/longitude, projected from map metres about `PROJECTION_ORIGIN` with the same
 * local-tangent-plane formula the backend's parser inverts (backend/src/laneletOsm.ts), so with
 * that origin set as the scene's `osmProjectionOrigin` every lane lands exactly on the floor plan.
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(ROOT, "config-runtime/scene-maps/yard-north-lanes.osm");

/** The yard's lower-left corner on the globe — `osmProjectionOrigin` in scenes.json. */
export const PROJECTION_ORIGIN = { lat: 31.0984407, lng: 121.3884294 };
const METRES_PER_DEGREE = (Math.PI * 6378137) / 180;

const toLatLng = ({ x, y }) => ({
  lat: PROJECTION_ORIGIN.lat + y / METRES_PER_DEGREE,
  lng:
    PROJECTION_ORIGIN.lng +
    x / (METRES_PER_DEGREE * Math.cos((PROJECTION_ORIGIN.lat * Math.PI) / 180)),
});

const HALF = 1.8;
let nextId = 1001;
const nodes = [];
const ways = [];
const relations = [];

const node = (point) => {
  const id = nextId++;
  const { lat, lng } = toLatLng(point);
  nodes.push(
    `  <node id="${id}" visible="true" version="1" lat="${lat.toFixed(11)}" lon="${lng.toFixed(11)}" />`,
  );
  return id;
};

const way = (points, tags) => {
  const refs = points.map(node);
  const id = nextId++;
  ways.push(
    [
      `  <way id="${id}" visible="true" version="1">`,
      ...refs.map((ref) => `    <nd ref="${ref}" />`),
      ...Object.entries(tags).map(([k, v]) => `    <tag k="${k}" v="${v}" />`),
      "  </way>",
    ].join("\n"),
  );
  return id;
};

const lanelet = ({ left, right, centerline, oneWay, name }) => {
  const leftId = way(left, { type: "line_thin", subtype: "solid" });
  const rightId = way(right, { type: "line_thin", subtype: "solid" });
  const centerId = way(centerline, { type: "line_thin", subtype: "dashed" });
  const id = nextId++;
  relations.push(
    [
      `  <relation id="${id}" visible="true" version="1">`,
      `    <member type="way" ref="${leftId}" role="left" />`,
      `    <member type="way" ref="${rightId}" role="right" />`,
      `    <member type="way" ref="${centerId}" role="centerline" />`,
      '    <tag k="type" v="lanelet" />',
      '    <tag k="subtype" v="road" />',
      '    <tag k="location" v="private" />',
      `    <tag k="one_way" v="${oneWay ? "yes" : "no"}" />`,
      `    <tag k="name" v="${name}" />`,
      "  </relation>",
    ].join("\n"),
  );
};

// The loop: inner (left, the loop runs anticlockwise) and outer (right) boundary rectangles, so
// the four sides meet in clean mitred corners.
const inner = {
  minX: 82 + HALF,
  maxX: 132 - HALF,
  minY: 22 + HALF,
  maxY: 70 - HALF,
};
const outer = {
  minX: 82 - HALF,
  maxX: 132 + HALF,
  minY: 22 - HALF,
  maxY: 70 + HALF,
};
const corners = (box) => [
  { x: box.minX, y: box.minY },
  { x: box.maxX, y: box.minY },
  { x: box.maxX, y: box.maxY },
  { x: box.minX, y: box.maxY },
];
const centre = corners({ minX: 82, maxX: 132, minY: 22, maxY: 70 });
const innerCorners = corners(inner);
const outerCorners = corners(outer);
["环路南段", "环路东段", "环路北段", "环路西段"].forEach((name, side) => {
  const next = (side + 1) % 4;
  lanelet({
    name,
    oneWay: true,
    left: [innerCorners[side], innerCorners[next]],
    right: [outerCorners[side], outerCorners[next]],
    centerline: [centre[side], centre[next]],
  });
});

// Spurs to dock doors B1–B3 (door faces at x ≈ 38.3 m), from the loop's outer west edge.
[
  ["B1 泊位支路", 64.1],
  ["B2 泊位支路", 49.7],
  ["B3 泊位支路", 35.3],
].forEach(([name, y]) => {
  lanelet({
    name,
    oneWay: false,
    left: [
      { x: outer.minX, y: y + HALF },
      { x: 40, y: y + HALF },
    ],
    right: [
      { x: outer.minX, y: y - HALF },
      { x: 40, y: y - HALF },
    ],
    centerline: [
      { x: outer.minX, y },
      { x: 40, y },
    ],
  });
});

// The access road: from the loop's outer south edge to the gate on the campus road.
lanelet({
  name: "南门进场道路",
  oneWay: false,
  left: [
    { x: 107 - HALF, y: outer.minY },
    { x: 107 - HALF, y: 2 },
  ],
  right: [
    { x: 107 + HALF, y: outer.minY },
    { x: 107 + HALF, y: 2 },
  ],
  centerline: [
    { x: 107, y: outer.minY },
    { x: 107, y: 2 },
  ],
});

const xml = [
  '<?xml version="1.0"?>',
  '<osm version="0.6" upload="false" generator="navfleet-demo-assets">',
  ...nodes,
  ...ways,
  ...relations,
  "</osm>",
  "",
].join("\n");
writeFileSync(OUT, xml);
console.log(
  `wrote ${OUT}: ${relations.length} lanelets, ${ways.length} ways, ${nodes.length} nodes`,
);
