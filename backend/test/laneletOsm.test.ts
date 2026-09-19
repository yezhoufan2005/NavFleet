import { describe, it, expect } from "vitest";
import { parseLaneletOsmText } from "../src/laneletOsm";

const SAMPLE_OSM = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="31.2300" lon="121.4700"/>
  <node id="2" lat="31.2301" lon="121.4700"/>
  <node id="3" lat="31.2300" lon="121.4702"/>
  <node id="4" lat="31.2301" lon="121.4702"/>
  <way id="10">
    <nd ref="1"/>
    <nd ref="2"/>
  </way>
  <way id="11">
    <nd ref="3"/>
    <nd ref="4"/>
  </way>
  <relation id="100">
    <tag k="type" v="lanelet"/>
    <tag k="subtype" v="road"/>
    <member type="way" ref="10" role="left"/>
    <member type="way" ref="11" role="right"/>
  </relation>
</osm>`;

describe("parseLaneletOsmText", () => {
  it("parses nodes, ways and lanelet relations into an overlay", () => {
    const overlay = parseLaneletOsmText(SAMPLE_OSM, "sample.osm", "scene-x");
    expect(overlay.sceneId).toBe("scene-x");
    expect(overlay.stats.nodeCount).toBe(4);
    expect(overlay.stats.wayCount).toBe(2);
    expect(overlay.stats.laneletCount).toBe(1);
    expect(overlay.lanelets[0]?.left).toHaveLength(2);
    expect(overlay.lanelets[0]?.right).toHaveLength(2);
    expect(overlay.projection.type).toBe("local-tangent-plane");
  });

  it("projects the origin node to the local origin (0,0)", () => {
    const overlay = parseLaneletOsmText(SAMPLE_OSM, "sample.osm", "scene-x", {
      lat: 31.23,
      lng: 121.47,
    });
    // node 1 sits exactly at the projection origin
    const originPoint = overlay.lanelets[0]?.left[0];
    expect(originPoint?.x).toBeCloseTo(0, 3);
    expect(originPoint?.y).toBeCloseTo(0, 3);
  });

  it("throws when the OSM text contains no nodes", () => {
    expect(() => parseLaneletOsmText("<osm></osm>", "empty.osm", "s")).toThrow();
  });

  it("skips lanelets tombstoned with delete=true rather than drawing them", () => {
    // Lanelet2 keeps a superseded lanelet in the file, tagged delete=true, instead of
    // removing it. Such a relation is history, not a live lane — it must not be drawn, and
    // must not count towards laneletCount.
    const withDeleted = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="31.2300" lon="121.4700"/>
  <node id="2" lat="31.2301" lon="121.4700"/>
  <node id="3" lat="31.2300" lon="121.4702"/>
  <node id="4" lat="31.2301" lon="121.4702"/>
  <way id="10"><nd ref="1"/><nd ref="2"/></way>
  <way id="11"><nd ref="3"/><nd ref="4"/></way>
  <relation id="100">
    <tag k="type" v="lanelet"/>
    <member type="way" ref="10" role="left"/>
    <member type="way" ref="11" role="right"/>
  </relation>
  <relation id="200">
    <tag k="type" v="lanelet"/>
    <tag k="delete" v="true"/>
    <member type="way" ref="10" role="left"/>
    <member type="way" ref="11" role="right"/>
  </relation>
</osm>`;
    const overlay = parseLaneletOsmText(withDeleted, "deleted.osm", "scene-x");
    expect(overlay.stats.laneletCount).toBe(1);
    expect(overlay.lanelets.map((lanelet) => lanelet.id)).toEqual(["100"]);
  });

  it("frames bounds around live lanelets only, not tombstone-only nodes", () => {
    // A delete=true lanelet can reference nodes that no live lane touches. Those tombstone
    // nodes must not stretch the overlay bounds, or the drawn network sits off-centre in an
    // oversized frame (the post-Phase-18 "地图渲染不对" regression). Here relation 300 is
    // tombstoned and its way 12 pulls in nodes 5/6 ~1113m north of the live lane; bounds
    // must ignore them.
    const withFarTombstone = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="31.2300" lon="121.4700"/>
  <node id="2" lat="31.2301" lon="121.4700"/>
  <node id="3" lat="31.2300" lon="121.4702"/>
  <node id="4" lat="31.2301" lon="121.4702"/>
  <node id="5" lat="31.2400" lon="121.4700"/>
  <node id="6" lat="31.2400" lon="121.4702"/>
  <way id="10"><nd ref="1"/><nd ref="2"/></way>
  <way id="11"><nd ref="3"/><nd ref="4"/></way>
  <way id="12"><nd ref="5"/><nd ref="6"/></way>
  <relation id="100">
    <tag k="type" v="lanelet"/>
    <member type="way" ref="10" role="left"/>
    <member type="way" ref="11" role="right"/>
  </relation>
  <relation id="300">
    <tag k="type" v="lanelet"/>
    <tag k="delete" v="true"/>
    <member type="way" ref="12" role="left"/>
    <member type="way" ref="12" role="right"/>
  </relation>
</osm>`;
    const overlay = parseLaneletOsmText(withFarTombstone, "far-tombstone.osm", "scene-x", {
      lat: 31.23,
      lng: 121.47,
    });
    expect(overlay.stats.laneletCount).toBe(1);
    // Live lane spans ~11m north (node 2), far tombstone would be ~1113m north (node 5).
    expect(overlay.bounds.maxY).toBeLessThan(100);
    expect(overlay.bounds.maxY).toBeCloseTo(11.132, 2);
    expect(overlay.bounds.minY).toBeCloseTo(0, 3);
  });

  it("falls back to node bounds when nothing is drawable", () => {
    // A scene with nodes but no live lanelet (e.g. everything tombstoned) still needs finite
    // bounds — the map has to frame *something*. With no drawn geometry to measure, fall back
    // to the full node set rather than emitting Infinity.
    const nodesOnly = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
  <node id="1" lat="31.2300" lon="121.4700"/>
  <node id="2" lat="31.2301" lon="121.4700"/>
</osm>`;
    const overlay = parseLaneletOsmText(nodesOnly, "nodes-only.osm", "scene-x", {
      lat: 31.23,
      lng: 121.47,
    });
    expect(overlay.stats.laneletCount).toBe(0);
    expect(overlay.lanelets).toHaveLength(0);
    expect(Number.isFinite(overlay.bounds.maxY)).toBe(true);
    expect(overlay.bounds.maxY).toBeCloseTo(11.132, 2);
  });
});
