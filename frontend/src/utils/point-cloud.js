const POINT_CLOUD_CACHE = new Map();

const HEADER_SCAN_BYTES = 64 * 1024;
const ASCII_DECODER = new TextDecoder("ascii");

function toFiniteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function fetchJson(url) {
  return fetch(url, { cache: "no-store" }).then((response) => {
    if (!response.ok) {
      throw new Error(`点云元数据加载失败: HTTP ${response.status}`);
    }
    return response.json();
  });
}

function fetchArrayBuffer(url) {
  return fetch(url, { cache: "no-store" }).then((response) => {
    if (!response.ok) {
      throw new Error(`点云文件加载失败: HTTP ${response.status}`);
    }
    return response.arrayBuffer();
  });
}

function parsePcdHeader(arrayBuffer) {
  const headerSlice = new Uint8Array(
    arrayBuffer,
    0,
    Math.min(arrayBuffer.byteLength, HEADER_SCAN_BYTES),
  );
  const headerText = ASCII_DECODER.decode(headerSlice);
  const match = headerText.match(/DATA\s+binary[^\r\n]*\r?\n/i);

  if (!match || match.index === undefined) {
    throw new Error("暂不支持当前 PCD 格式，未找到 DATA binary 头信息");
  }

  const headerLength = match.index + match[0].length;
  const lines = headerText
    .slice(0, headerLength)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const header = {};

  lines.forEach((line) => {
    const [keyword, ...rest] = line.split(/\s+/);
    header[keyword.toUpperCase()] = rest;
  });

  const fields = header.FIELDS || [];
  const sizes = (header.SIZE || []).map((value) => Number(value));
  const types = header.TYPE || [];
  const counts = (header.COUNT || []).map((value) => Number(value));
  const normalizedCounts = fields.map((_, index) => counts[index] || 1);

  let runningOffset = 0;
  const descriptors = fields.map((name, index) => {
    const descriptor = {
      name,
      size: sizes[index] || 4,
      type: types[index] || "F",
      count: normalizedCounts[index] || 1,
      offset: runningOffset,
    };
    runningOffset += descriptor.size * descriptor.count;
    return descriptor;
  });

  const width = Number(header.WIDTH?.[0] || 0);
  const height = Number(header.HEIGHT?.[0] || 1);
  const points = Number(header.POINTS?.[0] || width * height || 0);

  return {
    headerLength,
    pointCount: points,
    pointStride: runningOffset,
    fields: descriptors,
  };
}

function readScalar(dataView, offset, descriptor) {
  if (!descriptor || descriptor.count !== 1) {
    return Number.NaN;
  }

  const littleEndian = true;
  if (descriptor.type === "F" && descriptor.size === 4) {
    return dataView.getFloat32(offset, littleEndian);
  }
  if (descriptor.type === "F" && descriptor.size === 8) {
    return dataView.getFloat64(offset, littleEndian);
  }
  if (descriptor.type === "I" && descriptor.size === 1) {
    return dataView.getInt8(offset);
  }
  if (descriptor.type === "I" && descriptor.size === 2) {
    return dataView.getInt16(offset, littleEndian);
  }
  if (descriptor.type === "I" && descriptor.size === 4) {
    return dataView.getInt32(offset, littleEndian);
  }
  if (descriptor.type === "U" && descriptor.size === 1) {
    return dataView.getUint8(offset);
  }
  if (descriptor.type === "U" && descriptor.size === 2) {
    return dataView.getUint16(offset, littleEndian);
  }
  if (descriptor.type === "U" && descriptor.size === 4) {
    return dataView.getUint32(offset, littleEndian);
  }

  return Number.NaN;
}

function derivePointCloudGeometry(sceneDefinition = {}, meta = {}) {
  const gridSize =
    toFiniteNumber(meta.grid_size, toFiniteNumber(sceneDefinition.resolution, 0.2)) || 0.2;
  const originX = toFiniteNumber(meta.origin?.x, toFiniteNumber(sceneDefinition.origin?.x, 0)) || 0;
  const originY = toFiniteNumber(meta.origin?.y, toFiniteNumber(sceneDefinition.origin?.y, 0)) || 0;
  const width = Math.max(
    1,
    Math.round(toFiniteNumber(meta.shape?.width, toFiniteNumber(sceneDefinition.width, 1)) || 1),
  );
  const height = Math.max(
    1,
    Math.round(toFiniteNumber(meta.shape?.height, toFiniteNumber(sceneDefinition.height, 1)) || 1),
  );

  return {
    gridSize,
    originX,
    originY,
    width,
    height,
    bounds: {
      minX: originX,
      maxX: originX + width * gridSize,
      minY: originY,
      maxY: originY + height * gridSize,
    },
  };
}

function classifyPoint(pointZ, meta) {
  const floorMin = toFiniteNumber(meta.floor_band?.min_z);
  const floorMax = toFiniteNumber(meta.floor_band?.max_z);
  const obstacleMin = toFiniteNumber(meta.obstacle_band?.min_z);
  const obstacleMax = toFiniteNumber(meta.obstacle_band?.max_z);

  if (
    Number.isFinite(obstacleMin) &&
    Number.isFinite(obstacleMax) &&
    pointZ >= obstacleMin &&
    pointZ <= obstacleMax
  ) {
    return 2;
  }

  if (
    Number.isFinite(floorMin) &&
    Number.isFinite(floorMax) &&
    pointZ >= floorMin &&
    pointZ <= floorMax
  ) {
    return 1;
  }

  if (!Number.isFinite(obstacleMin) && !Number.isFinite(floorMin)) {
    return 1;
  }

  return 0;
}

function rasterizePointCloud(arrayBuffer, meta, sceneDefinition) {
  const geometry = derivePointCloudGeometry(sceneDefinition, meta);
  const { width, height, gridSize, originX, originY, bounds } = geometry;
  const occupancy = new Uint8Array(width * height);
  const intensityBuckets = new Uint8Array(width * height);
  const dataView = new DataView(arrayBuffer);
  const header = parsePcdHeader(arrayBuffer);
  const fieldMap = Object.fromEntries(header.fields.map((field) => [field.name, field]));

  for (let index = 0; index < header.pointCount; index += 1) {
    const baseOffset = header.headerLength + index * header.pointStride;
    if (baseOffset + header.pointStride > arrayBuffer.byteLength) {
      break;
    }

    const x = readScalar(dataView, baseOffset + (fieldMap.x?.offset || 0), fieldMap.x);
    const y = readScalar(dataView, baseOffset + (fieldMap.y?.offset || 0), fieldMap.y);
    const z = readScalar(dataView, baseOffset + (fieldMap.z?.offset || 0), fieldMap.z);
    const intensity = readScalar(
      dataView,
      baseOffset + (fieldMap.intensity?.offset || 0),
      fieldMap.intensity,
    );

    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }

    const cellX = Math.floor((x - originX) / gridSize);
    const cellY = Math.floor((y - originY) / gridSize);
    if (cellX < 0 || cellX >= width || cellY < 0 || cellY >= height) {
      continue;
    }

    const cellIndex = cellY * width + cellX;
    const nextClass = classifyPoint(z, meta);
    if (nextClass === 2 || (nextClass === 1 && occupancy[cellIndex] !== 2)) {
      occupancy[cellIndex] = nextClass;
    }

    if (Number.isFinite(intensity)) {
      intensityBuckets[cellIndex] = Math.max(
        intensityBuckets[cellIndex],
        Math.max(0, Math.min(255, Math.round(intensity))),
      );
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("浏览器无法创建点云渲染画布");
  }

  const imageData = context.createImageData(width, height);
  const pixels = imageData.data;

  for (let cellY = 0; cellY < height; cellY += 1) {
    for (let cellX = 0; cellX < width; cellX += 1) {
      const sourceIndex = cellY * width + cellX;
      const pixelIndex = ((height - 1 - cellY) * width + cellX) * 4;
      const pointClass = occupancy[sourceIndex];
      const intensity = intensityBuckets[sourceIndex];

      if (pointClass === 2) {
        pixels[pixelIndex] = 182;
        pixels[pixelIndex + 1] = 237;
        pixels[pixelIndex + 2] = 255;
        pixels[pixelIndex + 3] = Math.max(164, intensity);
        continue;
      }

      if (pointClass === 1) {
        pixels[pixelIndex] = 108;
        pixels[pixelIndex + 1] = 132;
        pixels[pixelIndex + 2] = 148;
        pixels[pixelIndex + 3] = Math.max(64, Math.min(146, Math.round(intensity * 0.75) || 82));
      }
    }
  }

  context.putImageData(imageData, 0, 0);

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width,
    height,
    bounds,
    meta,
  };
}

export async function loadPointCloudBackdrop(sceneDefinition) {
  if (!sceneDefinition?.pointCloudUrl) {
    return null;
  }

  const cacheKey = JSON.stringify({
    pointCloudUrl: sceneDefinition.pointCloudUrl,
    pointCloudMetaUrl: sceneDefinition.pointCloudMetaUrl || "",
    resolution: sceneDefinition.resolution,
    origin: sceneDefinition.origin,
    width: sceneDefinition.width,
    height: sceneDefinition.height,
  });

  if (POINT_CLOUD_CACHE.has(cacheKey)) {
    return POINT_CLOUD_CACHE.get(cacheKey);
  }

  const loadingPromise = Promise.all([
    fetchArrayBuffer(sceneDefinition.pointCloudUrl),
    sceneDefinition.pointCloudMetaUrl
      ? fetchJson(sceneDefinition.pointCloudMetaUrl)
      : Promise.resolve({}),
  ])
    .then(([arrayBuffer, meta]) => rasterizePointCloud(arrayBuffer, meta, sceneDefinition))
    .catch((error) => {
      POINT_CLOUD_CACHE.delete(cacheKey);
      throw error;
    });

  POINT_CLOUD_CACHE.set(cacheKey, loadingPromise);
  return loadingPromise;
}
