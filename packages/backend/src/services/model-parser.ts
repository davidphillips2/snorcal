import fs from 'node:fs';
import path from 'node:path';
import type { Bounds } from '@snorcal/shared';

/**
 * Parse binary STL to extract vertex count, face count, and bounding box.
 * Binary STL format:
 *   80 bytes header
 *   4 bytes uint32 face count
 *   For each face:
 *     12 bytes normal (3 floats)
 *     36 bytes vertices (9 floats: 3 vertices * 3 components)
 *     2 bytes attribute byte count
 *   = 50 bytes per face
 */
export function parseSTL(filePath: string): {
  faceCount: number;
  vertexCount: number;
  bounds: Bounds;
} {
  const buf = fs.readFileSync(filePath);

  if (buf.length < 84) {
    throw new Error('Invalid STL file: too small');
  }

  // Check if ASCII STL
  const header = buf.toString('ascii', 0, Math.min(80, buf.length));
  if (header.trimStart().startsWith('solid') && !isBinarySTL(buf)) {
    return parseASCIISTL(buf.toString('utf-8'));
  }

  // Binary STL
  const faceCount = buf.readUInt32LE(80);
  const expectedSize = 84 + faceCount * 50;
  if (buf.length < expectedSize) {
    throw new Error(`Invalid STL file: expected ${expectedSize} bytes, got ${buf.length}`);
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let i = 0; i < faceCount; i++) {
    const offset = 84 + i * 50;
    // Skip normal (12 bytes), read 3 vertices (36 bytes)
    for (let v = 0; v < 3; v++) {
      const vOff = offset + 12 + v * 12;
      const x = buf.readFloatLE(vOff);
      const y = buf.readFloatLE(vOff + 4);
      const z = buf.readFloatLE(vOff + 8);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }

  return {
    faceCount,
    vertexCount: faceCount * 3,
    bounds: {
      x: Math.abs(maxX - minX),
      y: Math.abs(maxY - minY),
      z: Math.abs(maxZ - minZ),
    },
  };
}

function isBinarySTL(buf: Buffer): boolean {
  const faceCount = buf.readUInt32LE(80);
  return buf.length === 84 + faceCount * 50;
}

function parseASCIISTL(text: string): { faceCount: number; vertexCount: number; bounds: Bounds } {
  let faceCount = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  const vertexRegex = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let match;
  while ((match = vertexRegex.exec(text)) !== null) {
    const x = parseFloat(match[1]);
    const y = parseFloat(match[2]);
    const z = parseFloat(match[3]);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  faceCount = (text.match(/endfacet/g) || []).length;

  return {
    faceCount,
    vertexCount: faceCount * 3,
    bounds: {
      x: Math.abs(maxX - minX),
      y: Math.abs(maxY - minY),
      z: Math.abs(maxZ - minZ),
    },
  };
}

/**
 * Read binary STL and return raw float positions (non-indexed, 3 floats per vertex).
 */
export function readSTLPositions(filePath: string): Float32Array {
  const buf = fs.readFileSync(filePath);

  // Check ASCII
  const header = buf.toString('ascii', 0, Math.min(80, buf.length));
  if (header.trimStart().startsWith('solid') && !isBinarySTL(buf)) {
    return readASCIISTLPositions(buf.toString('utf-8'));
  }

  const faceCount = buf.readUInt32LE(80);
  const positions = new Float32Array(faceCount * 9);

  for (let i = 0; i < faceCount; i++) {
    const offset = 84 + i * 50;
    for (let v = 0; v < 3; v++) {
      const srcOff = offset + 12 + v * 12;
      const dstOff = i * 9 + v * 3;
      positions[dstOff] = buf.readFloatLE(srcOff);
      positions[dstOff + 1] = buf.readFloatLE(srcOff + 4);
      positions[dstOff + 2] = buf.readFloatLE(srcOff + 8);
    }
  }

  return positions;
}

function readASCIISTLPositions(text: string): Float32Array {
  const vertices: number[] = [];
  const vertexRegex = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let match;
  while ((match = vertexRegex.exec(text)) !== null) {
    vertices.push(parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]));
  }
  return new Float32Array(vertices);
}

/**
 * Deduplicate STL positions: non-indexed → indexed.
 * Returns unique vertices and triangle indices.
 */
export function deduplicateVertices(rawPositions: Float32Array): {
  vertices: Float32Array;
  indices: Uint32Array;
} {
  const map = new Map<string, number>();
  const uniqueVerts: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < rawPositions.length; i += 3) {
    // Quantize to 6 decimal places to handle float imprecision
    const key = `${rawPositions[i].toFixed(6)},${rawPositions[i + 1].toFixed(6)},${rawPositions[i + 2].toFixed(6)}`;

    let idx = map.get(key);
    if (idx === undefined) {
      idx = uniqueVerts.length / 3;
      map.set(key, idx);
      uniqueVerts.push(rawPositions[i], rawPositions[i + 1], rawPositions[i + 2]);
    }
    indices.push(idx);
  }

  return {
    vertices: new Float32Array(uniqueVerts),
    indices: new Uint32Array(indices),
  };
}

export function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getDataDir(): string {
  return process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
}

export function getModelsDir(): string {
  return path.join(getDataDir(), 'models');
}

export function getJobsDir(): string {
  return path.join(getDataDir(), 'jobs');
}

export function getOutputDir(): string {
  return path.join(getDataDir(), 'output');
}
