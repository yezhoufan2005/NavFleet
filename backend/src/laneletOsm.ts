import fs from "node:fs/promises";
import path from "node:path";
import { LaneletOverlay } from "./types";

const EARTH_RADIUS = 6378137;

interface OsmNode {
  lat: number;
  lng: number;
}

interface OsmWay {
  id: string;
  refs: string[];
  tags: Record<string, string>;
}

interface RawLanelet {
  id: string;
  subtype: string;
  oneWay: string;
  left: string;
  right: string;
  centerline: string;
}

interface ProjectionOrigin {
  lat: number;
  lng: number;
}

const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

const ATTRIBUTE_PATTERN = /(\w+)=(?:"([^"]*)"|'([^']*)')/g;
const NODE_PATTERN = /<node\b([^>]*)\/>/g;
const WAY_PATTERN = /<way\b([^>]*)>([\s\S]*?)<\/way>/g;
const RELATION_PATTERN = /<relation\b([^>]*)>([\s\S]*?)<\/relation>/g;
const ND_PATTERN = /<nd\b([^>]*)\/>/g;
const TAG_PATTERN = /<tag\b([^>]*)\/>/g;
const MEMBER_PATTERN = /<member\b([^>]*)\/>/g;

const parseAttributes = (fragment: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  for (const [, name = "", quoted, apostrophed] of fragment.matchAll(ATTRIBUTE_PATTERN)) {
    attributes[name] = quoted ?? apostrophed ?? "";
  }
  return attributes;
};

/**
 * One XML element this parser cares about: its attributes, and its inner body.
 *
 * **Every element here had its own hand-rolled `exec` loop** — six of them, each reading
 * `match[1]` and, for containers, `match[2]`. Those reads are provably present for these
 * patterns, and typed `string | undefined` regardless, because a capture group's type does
 * not depend on whether the pattern can skip it. Under `noUncheckedIndexedAccess` that was
 * **15 of this file's 16**「possibly undefined」— one shape, fifteen times.
 *
 * Collapsing the loops answers all fifteen at once and drops the
 * `let m = re.exec(x); while (m) { …; m = re.exec(x); }` bookkeeping, whose failure mode is
 * an infinite loop. `matchAll` also clones the regex internally, so the patterns can now be
 * module constants without `lastIndex` leaking between two bodies — which is exactly why the
 * nested ones previously had to be re-declared inside their outer loop.
 */
interface XmlElement {
  /** Parsed `key="value"` pairs from the opening tag. */
  attributes: Record<string, string>;
  /** Everything between the tags; `""` for the self-closing patterns. */
  body: string;
}

const elementsOf = (xml: string, pattern: RegExp): XmlElement[] =>
  [...xml.matchAll(pattern)].map((match) => ({
    attributes: parseAttributes(match[1] ?? ""),
    body: match[2] ?? "",
  }));

/** `<tag k=… v=…/>` children as a record — identical in `<way>` and `<relation>`. */
const tagsOf = (body: string): Record<string, string> => {
  const tags: Record<string, string> = {};
  for (const { attributes } of elementsOf(body, TAG_PATTERN)) {
    if (attributes.k) {
      tags[attributes.k] = attributes.v || "";
    }
  }
  return tags;
};

const projectLngLat = (lng: number, lat: number, originLng: number, originLat: number) => {
  const originLatRad = (originLat * Math.PI) / 180;
  const x = ((lng - originLng) * Math.PI * EARTH_RADIUS * Math.cos(originLatRad)) / 180;
  const y = ((lat - originLat) * Math.PI * EARTH_RADIUS) / 180;
  return { x, y };
};

const extractNodes = (xmlText: string): Map<string, OsmNode> => {
  const nodes = new Map<string, OsmNode>();

  for (const { attributes } of elementsOf(xmlText, NODE_PATTERN)) {
    const lat = Number(attributes.lat);
    const lng = Number(attributes.lon);
    if (attributes.id && Number.isFinite(lat) && Number.isFinite(lng)) {
      nodes.set(attributes.id, { lat, lng });
    }
  }

  return nodes;
};

const extractWays = (xmlText: string): Map<string, OsmWay> => {
  const ways = new Map<string, OsmWay>();

  for (const { attributes, body } of elementsOf(xmlText, WAY_PATTERN)) {
    const refs = elementsOf(body, ND_PATTERN)
      .map((nd) => nd.attributes.ref)
      .filter((ref): ref is string => Boolean(ref));

    if (attributes.id) {
      ways.set(attributes.id, {
        id: attributes.id,
        refs,
        tags: tagsOf(body),
      });
    }
  }

  return ways;
};

const extractLanelets = (xmlText: string): RawLanelet[] => {
  const lanelets: RawLanelet[] = [];

  for (const { attributes, body } of elementsOf(xmlText, RELATION_PATTERN)) {
    const tags = tagsOf(body);
    if (tags.type !== "lanelet") {
      continue;
    }

    const members = elementsOf(body, MEMBER_PATTERN).map((member) => member.attributes);

    lanelets.push({
      id: attributes.id || `${lanelets.length + 1}`,
      subtype: tags.subtype || "road",
      oneWay: tags.one_way || "",
      left: members.find((item) => item.role === "left")?.ref || "",
      right: members.find((item) => item.role === "right")?.ref || "",
      centerline: members.find((item) => item.role === "centerline")?.ref || "",
    });
  }

  return lanelets;
};

export const parseLaneletOsmText = (
  xmlText: string,
  sourceName: string,
  sceneId: string,
  projectionOrigin?: ProjectionOrigin,
): LaneletOverlay => {
  const nodes = extractNodes(xmlText);
  const ways = extractWays(xmlText);
  const lanelets = extractLanelets(xmlText);

  const firstNode = nodes.values().next().value;
  if (!firstNode) {
    throw new Error("OSM file does not contain any nodes.");
  }

  const origin =
    projectionOrigin &&
    Number.isFinite(projectionOrigin.lat) &&
    Number.isFinite(projectionOrigin.lng)
      ? projectionOrigin
      : { lat: firstNode.lat, lng: firstNode.lng };

  const projectedNodes = new Map<string, { x: number; y: number }>();
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [nodeId, node] of nodes.entries()) {
    const projected = projectLngLat(node.lng, node.lat, origin.lng, origin.lat);
    projectedNodes.set(nodeId, projected);
    minX = Math.min(minX, projected.x);
    maxX = Math.max(maxX, projected.x);
    minY = Math.min(minY, projected.y);
    maxY = Math.max(maxY, projected.y);
  }

  const normalizePoint = (point: { x: number; y: number }) => ({
    x: round(point.x, 3),
    y: round(point.y, 3),
  });

  const mapWayPoints = (wayId: string) => {
    const way = ways.get(wayId);
    if (!way) {
      return [];
    }

    return way.refs
      .map((ref) => projectedNodes.get(ref))
      .filter((point): point is { x: number; y: number } => Boolean(point))
      .map(normalizePoint);
  };

  return {
    sceneId,
    source: sourceName,
    generator: "lanelet2",
    projection: {
      type: "local-tangent-plane",
      originLat: origin.lat,
      originLng: origin.lng,
    },
    bounds: {
      minX: round(minX, 3),
      minY: round(minY, 3),
      maxX: round(maxX, 3),
      maxY: round(maxY, 3),
    },
    stats: {
      nodeCount: nodes.size,
      wayCount: ways.size,
      laneletCount: lanelets.length,
    },
    lanelets: lanelets
      .map((lanelet) => ({
        id: lanelet.id,
        subtype: lanelet.subtype,
        oneWay: lanelet.oneWay,
        left: mapWayPoints(lanelet.left),
        right: mapWayPoints(lanelet.right),
        centerline: mapWayPoints(lanelet.centerline),
      }))
      .filter(
        (lanelet) => lanelet.left.length || lanelet.right.length || lanelet.centerline.length,
      ),
  };
};

export const parseLaneletOsmFile = async (
  filePath: string,
  sceneId: string,
  projectionOrigin?: ProjectionOrigin,
): Promise<LaneletOverlay> => {
  const xmlText = await fs.readFile(filePath, "utf8");
  return parseLaneletOsmText(xmlText, path.basename(filePath), sceneId, projectionOrigin);
};
