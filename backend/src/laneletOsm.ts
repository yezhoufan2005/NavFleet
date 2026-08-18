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

const parseAttributes = (fragment: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  const regex = /(\w+)=(?:"([^"]*)"|'([^']*)')/g;
  let match = regex.exec(fragment);
  while (match) {
    attributes[match[1]] = match[2] ?? match[3] ?? "";
    match = regex.exec(fragment);
  }
  return attributes;
};

const projectLngLat = (lng: number, lat: number, originLng: number, originLat: number) => {
  const originLatRad = (originLat * Math.PI) / 180;
  const x = ((lng - originLng) * Math.PI * EARTH_RADIUS * Math.cos(originLatRad)) / 180;
  const y = ((lat - originLat) * Math.PI * EARTH_RADIUS) / 180;
  return { x, y };
};

const extractNodes = (xmlText: string): Map<string, OsmNode> => {
  const nodes = new Map<string, OsmNode>();
  const nodeRegex = /<node\b([^>]*)\/>/g;
  let match = nodeRegex.exec(xmlText);

  while (match) {
    const attributes = parseAttributes(match[1]);
    const lat = Number(attributes.lat);
    const lng = Number(attributes.lon);
    if (attributes.id && Number.isFinite(lat) && Number.isFinite(lng)) {
      nodes.set(attributes.id, { lat, lng });
    }
    match = nodeRegex.exec(xmlText);
  }

  return nodes;
};

const extractWays = (xmlText: string): Map<string, OsmWay> => {
  const ways = new Map<string, OsmWay>();
  const wayRegex = /<way\b([^>]*)>([\s\S]*?)<\/way>/g;
  let match = wayRegex.exec(xmlText);

  while (match) {
    const attributes = parseAttributes(match[1]);
    const body = match[2];
    const refs: string[] = [];
    const ndRegex = /<nd\b([^>]*)\/>/g;
    let ndMatch = ndRegex.exec(body);
    while (ndMatch) {
      const ndAttributes = parseAttributes(ndMatch[1]);
      if (ndAttributes.ref) {
        refs.push(ndAttributes.ref);
      }
      ndMatch = ndRegex.exec(body);
    }

    const tags: Record<string, string> = {};
    const tagRegex = /<tag\b([^>]*)\/>/g;
    let tagMatch = tagRegex.exec(body);
    while (tagMatch) {
      const tagAttributes = parseAttributes(tagMatch[1]);
      if (tagAttributes.k) {
        tags[tagAttributes.k] = tagAttributes.v || "";
      }
      tagMatch = tagRegex.exec(body);
    }

    if (attributes.id) {
      ways.set(attributes.id, {
        id: attributes.id,
        refs,
        tags,
      });
    }

    match = wayRegex.exec(xmlText);
  }

  return ways;
};

const extractLanelets = (xmlText: string): RawLanelet[] => {
  const lanelets: RawLanelet[] = [];
  const relationRegex = /<relation\b([^>]*)>([\s\S]*?)<\/relation>/g;
  let match = relationRegex.exec(xmlText);

  while (match) {
    const attributes = parseAttributes(match[1]);
    const body = match[2];
    const tags: Record<string, string> = {};
    const members: Array<Record<string, string>> = [];

    const tagRegex = /<tag\b([^>]*)\/>/g;
    let tagMatch = tagRegex.exec(body);
    while (tagMatch) {
      const tagAttributes = parseAttributes(tagMatch[1]);
      if (tagAttributes.k) {
        tags[tagAttributes.k] = tagAttributes.v || "";
      }
      tagMatch = tagRegex.exec(body);
    }

    if (tags.type !== "lanelet") {
      match = relationRegex.exec(xmlText);
      continue;
    }

    const memberRegex = /<member\b([^>]*)\/>/g;
    let memberMatch = memberRegex.exec(body);
    while (memberMatch) {
      members.push(parseAttributes(memberMatch[1]));
      memberMatch = memberRegex.exec(body);
    }

    lanelets.push({
      id: attributes.id || `${lanelets.length + 1}`,
      subtype: tags.subtype || "road",
      oneWay: tags.one_way || "",
      left: members.find((item) => item.role === "left")?.ref || "",
      right: members.find((item) => item.role === "right")?.ref || "",
      centerline: members.find((item) => item.role === "centerline")?.ref || "",
    });

    match = relationRegex.exec(xmlText);
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
