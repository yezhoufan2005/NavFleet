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
    expect(overlay.lanelets[0].left).toHaveLength(2);
    expect(overlay.lanelets[0].right).toHaveLength(2);
    expect(overlay.projection.type).toBe("local-tangent-plane");
  });

  it("projects the origin node to the local origin (0,0)", () => {
    const overlay = parseLaneletOsmText(SAMPLE_OSM, "sample.osm", "scene-x", {
      lat: 31.23,
      lng: 121.47,
    });
    // node 1 sits exactly at the projection origin
    const originPoint = overlay.lanelets[0].left[0];
    expect(originPoint.x).toBeCloseTo(0, 3);
    expect(originPoint.y).toBeCloseTo(0, 3);
  });

  it("throws when the OSM text contains no nodes", () => {
    expect(() => parseLaneletOsmText("<osm></osm>", "empty.osm", "s")).toThrow();
  });
});
