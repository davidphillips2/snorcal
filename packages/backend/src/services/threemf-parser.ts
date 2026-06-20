import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import fs from 'node:fs';
import type { Bounds } from '@snorcal/shared';

export interface Parse3MFResult {
  /** Non-indexed positions: 9 floats per face (3 vertices * xyz) */
  positions: Float32Array;
  /** RGBA per face (4 bytes per face) */
  faceColors: Uint8Array | null;
  faceCount: number;
  bounds: Bounds;
}

interface MeshEntry {
  positions: Float32Array;
  faceColors: Uint8Array | null;
  triCount: number;
  /** Extruder number for this mesh entry (from model_settings part mapping) */
  extruder?: number;
  /** If true, faceColors contains raw extruder indices (from paint_color) needing resolution */
  needsExtruderResolution?: boolean;
}

const PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
};

/**
 * Parse a 3MF file and extract geometry + per-face colors.
 *
 * Handles two 3MF layouts:
 *   1. Inline mesh (our own exports): <object><mesh> directly in 3dmodel.model
 *   2. External components (BambuStudio/OrcaSlicer): objects reference
 *      separate .model files in 3D/Objects/ via <component p:path="...">
 *
 * Colors come from:
 *   - Per-face paint_color attributes (BambuStudio painted models)
 *   - Per-face: <m:colorgroup> + triangle p1/p2/p3 attributes
 *   - Per-object/part: extruder assignment from model_settings.config → filament color
 *   - Mixed filament definitions for virtual extruders
 */
export async function parse3MF(buffer: Buffer, plateNumber?: number): Promise<Parse3MFResult> {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new XMLParser(PARSER_OPTIONS);

  // Find and parse the main model file
  const modelXml = await readModelXml(zip);
  const doc = parser.parse(modelXml);

  const model = doc.model;
  if (!model) throw new Error('Invalid 3MF: no <model> element');

  const resources = model.resources;
  if (!resources) throw new Error('Invalid 3MF: no <resources>');

  // Parse model_settings.config for plate filtering and part→extruder mapping
  const modelSettings = await parseModelSettings(zip, parser);

  // Resolve which object IDs to include for the requested plate
  const targetPlate = plateNumber ?? 1;
  const plateObjIds = modelSettings.plates.get(targetPlate);

  // Parse build item transforms — <item objectid="..." transform="..."/>
  const buildItemTransforms = new Map<string, string>();
  const build = model.build;
  if (build) {
    const items = toArray(build.item);
    for (const item of items) {
      const itemId = String(item['@_objectid'] || '');
      const itemTransform = item['@_transform'];
      if (itemId && itemTransform) {
        buildItemTransforms.set(itemId, itemTransform);
      }
    }
  }

  // Collect all meshes — either inline or via external component references
  const objects = toArray(resources.object);
  const meshEntries: MeshEntry[] = [];
  // Cache for external model files to avoid re-parsing
  const extFileCache = new Map<string, any>();

  for (const obj of objects) {
    const objId = String(obj['@_id'] || '');

    // Skip objects not on the target plate (if we have plate info)
    if (plateObjIds && plateObjIds.size > 0 && !plateObjIds.has(objId)) continue;

    // Case 1: Inline mesh
    if (obj.mesh) {
      const result = parseMesh(obj);
      if (result) {
        // Apply build item transform (scale/translation from <build><item>)
        const itemTransform = buildItemTransforms.get(objId);
        if (itemTransform) applyTransform(result.positions, itemTransform);
        result.extruder = modelSettings.objectExtruders.get(objId);
        meshEntries.push(result);
      }
      continue;
    }

    // Case 2: External component references
    const components = obj.components;
    if (components) {
      const entryStartIdx = meshEntries.length;
      const componentList = toArray(components.component);
      for (const comp of componentList) {
        const extPath = comp['@_p:path'];
        if (!extPath) continue;

        // JSZip paths don't have leading slash
        const normalizedPath = extPath.startsWith('/') ? extPath.slice(1) : extPath;
        const targetObjId = String(comp['@_objectid'] || '');
        const transform = comp['@_transform'];

        // Parse or get cached external model
        let extDoc: any;
        if (extFileCache.has(normalizedPath)) {
          extDoc = extFileCache.get(normalizedPath);
        } else {
          const extFile = zip.file(normalizedPath);
          if (!extFile) continue;
          try {
            const extXml = await extFile.async('text');
            extDoc = parser.parse(extXml);
            extFileCache.set(normalizedPath, extDoc);
          } catch {
            continue;
          }
        }

        const extModel = extDoc?.model;
        if (!extModel?.resources) continue;

        const extObjects = toArray(extModel.resources.object);

        // If targetObjId specified, only load that specific object
        if (targetObjId) {
          const extObj = extObjects.find((o: any) => String(o['@_id']) === targetObjId);
          if (extObj?.mesh) {
            const result = parseMesh(extObj);
            if (result) {
              // Apply component transform
              if (transform) applyTransform(result.positions, transform);
              // Look up extruder for this part (keyed by objectid_in_main → part id)
              const partKey = `${objId}:${targetObjId}`;
              result.extruder = modelSettings.partExtruders.get(partKey)
                ?? modelSettings.objectExtruders.get(objId);
              meshEntries.push(result);
            }
          }
        } else {
          // No specific objectid — load all meshes from external file
          for (const extObj of extObjects) {
            if (extObj.mesh) {
              const result = parseMesh(extObj);
              if (result) {
                if (transform) applyTransform(result.positions, transform);
                result.extruder = modelSettings.objectExtruders.get(objId);
                meshEntries.push(result);
              }
            }
          }
        }
      }

      // Apply build item transform (scale/translation from <build><item>) to all entries from this object
      const itemTransform = buildItemTransforms.get(objId);
      if (itemTransform) {
        for (let i = entryStartIdx; i < meshEntries.length; i++) {
          applyTransform(meshEntries[i].positions, itemTransform);
        }
      }
    }
  }

  if (meshEntries.length === 0) {
    throw new Error('No meshes found in 3MF file');
  }

  // Load filament colors (base + mixed)
  const filamentColors = await parseFilamentColors(zip);

  // Merge all meshes into one, swapping Y↔Z (3MF/slicers use Z-up, Three.js uses Y-up)
  const totalFaces = meshEntries.reduce((sum, e) => sum + e.triCount, 0);
  const allPositions = new Float32Array(totalFaces * 9);
  const allColors = new Uint8Array(totalFaces * 4);
  let hasAnyColor = false;
  let faceOffset = 0;

  for (const entry of meshEntries) {
    // Copy positions with Y↔Z swap for proper Y-up orientation
    for (let i = 0; i < entry.triCount; i++) {
      const src = i * 9;
      const dst = (faceOffset + i) * 9;
      for (let v = 0; v < 3; v++) {
        const sv = src + v * 3;
        const dv = dst + v * 3;
        allPositions[dv] = entry.positions[sv];       // X stays
        allPositions[dv + 1] = entry.positions[sv + 2]; // Z → Y (up)
        allPositions[dv + 2] = entry.positions[sv + 1]; // Y → Z (depth)
      }
    }

    if (entry.faceColors) {
      if (entry.needsExtruderResolution && filamentColors.size > 0) {
        // paint_color format: R=extruder_num, G=0, B=0, A=marker → resolve to actual color
        const src = entry.faceColors;
        for (let i = 0; i < entry.triCount; i++) {
          const sOff = i * 4;
          const dOff = (faceOffset + i) * 4;
          const extNum = src[sOff]; // extruder number
          const color = filamentColors.get(extNum);
          if (color) {
            allColors[dOff] = color[0];
            allColors[dOff + 1] = color[1];
            allColors[dOff + 2] = color[2];
            allColors[dOff + 3] = 255;
          } else {
            // Unknown extruder — use object's extruder color or white
            const fallback = (entry.extruder && filamentColors.get(entry.extruder)) || [255, 255, 255];
            allColors[dOff] = fallback[0];
            allColors[dOff + 1] = fallback[1];
            allColors[dOff + 2] = fallback[2];
            allColors[dOff + 3] = 255;
          }
        }
      } else {
        allColors.set(entry.faceColors, faceOffset * 4);
      }
      hasAnyColor = true;
    } else if (entry.extruder && filamentColors.has(entry.extruder)) {
      // Apply extruder color to all faces of this mesh entry
      const [r, g, b] = filamentColors.get(entry.extruder)!;
      for (let i = 0; i < entry.triCount; i++) {
        const off = (faceOffset + i) * 4;
        allColors[off] = r;
        allColors[off + 1] = g;
        allColors[off + 2] = b;
        allColors[off + 3] = 255;
      }
      hasAnyColor = true;
    } else {
      // Fill with white (opaque)
      for (let i = 0; i < entry.triCount * 4; i += 4) {
        const off = faceOffset * 4 + i;
        allColors[off] = 255;
        allColors[off + 1] = 255;
        allColors[off + 2] = 255;
        allColors[off + 3] = 255;
      }
    }
    faceOffset += entry.triCount;
  }

  // Compute bounds
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < allPositions.length; i += 3) {
    const x = allPositions[i], y = allPositions[i + 1], z = allPositions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  return {
    positions: allPositions,
    faceColors: hasAnyColor ? allColors : null,
    faceCount: totalFaces,
    bounds: {
      x: Math.abs(maxX - minX),
      y: Math.abs(maxY - minY),
      z: Math.abs(maxZ - minZ),
    },
  };
}

interface ModelSettings {
  /** object id → default extruder (from object-level metadata) */
  objectExtruders: Map<string, number>;
  /** "mainObjId:partId" → extruder (from part-level metadata) */
  partExtruders: Map<string, number>;
  /** plate number → set of object IDs on that plate */
  plates: Map<number, Set<string>>;
}

/**
 * Parse model_settings.config for plate and extruder info.
 */
async function parseModelSettings(zip: JSZip, parser: XMLParser): Promise<ModelSettings> {
  const result: ModelSettings = {
    objectExtruders: new Map(),
    partExtruders: new Map(),
    plates: new Map(),
  };

  const file = zip.file('Metadata/model_settings.config');
  if (!file) return result;

  try {
    const xml = await file.async('text');
    const doc = parser.parse(xml);
    const config = doc.config;
    if (!config) return result;

    // Parse objects and their parts
    const objects = toArray(config.object);
    for (const obj of objects) {
      const objId = String(obj['@_id'] || '');

      // Object-level extruder
      const objMetas = toArray(obj.metadata);
      for (const m of objMetas) {
        if (m['@_key'] === 'extruder') {
          result.objectExtruders.set(objId, parseInt(m['@_value'] || '1'));
        }
      }

      // Part-level extruders (override object-level)
      const parts = toArray(obj.part);
      for (const part of parts) {
        const partId = String(part['@_id'] || '');
        const partMetas = toArray(part.metadata);
        for (const m of partMetas) {
          if (m['@_key'] === 'extruder') {
            result.partExtruders.set(`${objId}:${partId}`, parseInt(m['@_value'] || '1'));
          }
        }
      }
    }

    // Parse ALL plates and their object IDs
    const plates = toArray(config.plate);
    for (const plate of plates) {
      const plateMetas = toArray(plate.metadata);
      const platerId = plateMetas.find((m: any) => m['@_key'] === 'plater_id');
      if (!platerId) continue;
      const plateNum = parseInt(platerId['@_value']);
      if (isNaN(plateNum)) continue;

      const objIds = new Set<string>();
      const instances = toArray(plate.model_instance);
      for (const inst of instances) {
        const instMetas = toArray(inst.metadata);
        const objIdMeta = instMetas.find((m: any) => m['@_key'] === 'object_id');
        if (objIdMeta) {
          objIds.add(String(objIdMeta['@_value']));
        }
      }
      result.plates.set(plateNum, objIds);
    }
  } catch {
    // No model_settings or parse error — return defaults
  }

  return result;
}

/**
 * Parse base filament colors and mixed filament definitions from project_settings.config.
 * Returns a map of extruder number → [r, g, b].
 */
async function parseFilamentColors(zip: JSZip): Promise<Map<number, [number, number, number]>> {
  const colorMap = new Map<number, [number, number, number]>();

  const file = zip.file('Metadata/project_settings.config');
  if (!file) return colorMap;

  try {
    const text = await file.async('text');
    const settings = JSON.parse(text);

    // Base filament colors (extruders 1..N)
    const colors: string[] = settings.filament_colour || [];
    for (let i = 0; i < colors.length; i++) {
      const c = parseCSSColor(colors[i]);
      if (c) colorMap.set(i + 1, c);
    }

    // Mixed filament definitions — compute colors for virtual extruders
    const mfd: string = settings.mixed_filament_definitions || '';
    if (mfd && colors.length > 0) {
      // Format: "f1,f2,mode,waveform,pct,flags,...,uN" separated by ";"
      // pct is the percentage of filament f2 mixed with f1
      const baseRgb = colors.map(c => parseCSSColor(c)).filter(Boolean) as [number, number, number][];

      for (const def of mfd.split(';')) {
        const parts = def.split(',');
        if (parts.length < 5) continue;

        const f1 = parseInt(parts[0]) - 1; // 1-indexed to 0-indexed
        const f2 = parseInt(parts[1]) - 1;
        const pct = parseInt(parts[4]) || 50;
        const uMatch = parts[parts.length - 1].match(/u(\d+)/);
        if (!uMatch) continue;

        const extruderNum = parseInt(uMatch[1]);
        if (colorMap.has(extruderNum)) continue;

        const c1 = baseRgb[f1];
        const c2 = baseRgb[f2];
        if (c1 && c2) {
          // Mix: pct is percentage of f2 (so (100-pct)% of f1)
          const t = pct / 100;
          colorMap.set(extruderNum, [
            Math.round(c1[0] * (1 - t) + c2[0] * t),
            Math.round(c1[1] * (1 - t) + c2[1] * t),
            Math.round(c1[2] * (1 - t) + c2[2] * t),
          ]);
        }
      }
    }
  } catch {
    // No project settings — fine
  }

  return colorMap;
}

/**
 * Apply a 3MF transform matrix to all vertices in a positions array.
 * 3MF stores transforms in column-major 4x3 format:
 *   col0 col1 col2 col3 → (a0 a1 a2) (b0 b1 b2) (c0 c1 c2) (tx ty tz)
 * Which forms the matrix:
 *   | a0 b0 c0 tx |
 *   | a1 b1 c1 ty |
 *   | a2 b2 c2 tz |
 *   |  0  0  0  1 |
 */
function applyTransform(positions: Float32Array, transform: string): void {
  const v = transform.trim().split(/\s+/).map(Number);
  if (v.length < 9) return;

  // Column-major: first 3 = X-axis, next 3 = Y-axis, next 3 = Z-axis, last 3 = translation
  const a0 = v[0], a1 = v[1], a2 = v[2];       // X-axis (col 0)
  const b0 = v[3], b1 = v[4], b2 = v[5];       // Y-axis (col 1)
  const c0 = v[6], c1 = v[7], c2 = v[8];       // Z-axis (col 2)
  const tx = v.length > 9 ? v[9] : 0;          // Translation
  const ty = v.length > 10 ? v[10] : 0;
  const tz = v.length > 11 ? v[11] : 0;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    positions[i]     = x * a0 + y * b0 + z * c0 + tx;
    positions[i + 1] = x * a1 + y * b1 + z * c1 + ty;
    positions[i + 2] = x * a2 + y * b2 + z * c2 + tz;
  }
}

/**
 * Parse a mesh object (inline or external) into positions + face colors.
 */
function parseMesh(obj: any): MeshEntry | null {
  const mesh = obj.mesh;
  if (!mesh?.vertices || !mesh.triangles) return null;

  const vertList = toArray(mesh.vertices.vertex);
  const triList = toArray(mesh.triangles.triangle);
  if (vertList.length === 0 || triList.length === 0) return null;

  // Parse vertices
  const vertexData = new Float32Array(vertList.length * 3);
  for (let i = 0; i < vertList.length; i++) {
    vertexData[i * 3] = parseFloat(vertList[i]['@_x'] || 0);
    vertexData[i * 3 + 1] = parseFloat(vertList[i]['@_y'] || 0);
    vertexData[i * 3 + 2] = parseFloat(vertList[i]['@_z'] || 0);
  }

  // Build non-indexed positions
  const faceCount = triList.length;
  const positions = new Float32Array(faceCount * 9);
  for (let f = 0; f < faceCount; f++) {
    const tri = triList[f];
    const v1 = parseInt(tri['@_v1']);
    const v2 = parseInt(tri['@_v2']);
    const v3 = parseInt(tri['@_v3']);

    for (let v = 0; v < 3; v++) {
      const vi = [v1, v2, v3][v];
      positions[f * 9 + v * 3] = vertexData[vi * 3];
      positions[f * 9 + v * 3 + 1] = vertexData[vi * 3 + 1];
      positions[f * 9 + v * 3 + 2] = vertexData[vi * 3 + 2];
    }
  }

  // Try to extract per-face colors
  let faceColors: Uint8Array | null = null;

  // 1. Try paint_color attributes (BambuStudio painted models)
  faceColors = extractPaintColors(triList, faceCount);
  if (faceColors) return { positions, faceColors, triCount: faceCount, needsExtruderResolution: true };

  // 2. Try colorgroup from resources
  try {
    faceColors = extractColorsFromResources(obj, triList);
    if (!faceColors && mesh.resources) {
      faceColors = extractColorsFromResources(mesh, triList);
    }
  } catch {
    // No colors
  }

  return { positions, faceColors, triCount: faceCount };
}

/**
 * Extract per-face colors from BambuStudio paint_color attributes.
 * Each triangle may have a paint_color attribute — a hex number encoding the extruder index.
 *
 * BambuStudio uses two encoding schemes:
 *   - "Nibble" encoding: all values are multiples of 4 ({0,4,8,C}) → divide by 4 for extruder index
 *   - Direct encoding: values are direct extruder indices ({0,1,2,3,...})
 */
function extractPaintColors(triList: any[], faceCount: number): Uint8Array | null {
  // Collect all unique paint_color hex values to detect encoding scheme
  const uniqueValues = new Set<number>();
  let hasAny = false;
  for (let i = 0; i < triList.length; i++) {
    const pc = triList[i]['@_paint_color'];
    if (!pc) continue;
    hasAny = true;
    uniqueValues.add(parseInt(String(pc), 16));
  }
  if (!hasAny) return null;

  // Detect nibble encoding: if every unique value is a multiple of 4, divide by 4
  const allMultiplesOf4 = [...uniqueValues].every(v => v % 4 === 0);
  const divisor = allMultiplesOf4 ? 4 : 1;

  const faceColors = new Uint8Array(faceCount * 4);
  let hasColor = false;

  for (let i = 0; i < triList.length; i++) {
    const paintColor = triList[i]['@_paint_color'];
    if (!paintColor) continue;

    const extruderNum = parseInt(String(paintColor), 16) / divisor;
    if (extruderNum > 0 && i < faceCount) {
      faceColors[i * 4] = extruderNum;
      faceColors[i * 4 + 1] = 0;
      faceColors[i * 4 + 2] = 0;
      faceColors[i * 4 + 3] = 1;
      hasColor = true;
    }
  }

  return hasColor ? faceColors : null;
}

/**
 * Extract per-face colors from a resources or object element.
 */
function extractColorsFromResources(container: any, triList: any[]): Uint8Array | null {
  const resources = container.resources || container;
  const colorGroups: Map<string, string[]> = new Map();

  for (const key of Object.keys(resources)) {
    if (key === 'colorgroup' || key.endsWith(':colorgroup')) {
      const groups = toArray(resources[key]);
      for (const group of groups) {
        const id = String(group['@_id'] || '1');
        const colors = toArray(group.color);
        const hexColors = colors.map((c: any) =>
          typeof c === 'string' ? c : String(c['@_color'] || '#FFFFFFFF'),
        );
        colorGroups.set(id, hexColors);
      }
    }
  }

  if (colorGroups.size === 0) return null;

  const [, hexColors] = colorGroups.entries().next().value!;
  if (!hexColors || hexColors.length === 0) return null;

  const parsedColors = hexColors.map((hex: string) => parseHexColor(hex));
  const faceColors = new Uint8Array(triList.length * 4);
  let hasColor = false;

  for (let f = 0; f < triList.length; f++) {
    const tri = triList[f];
    const p1 = tri['@_p1'];

    if (p1 !== undefined) {
      const idx = parseInt(p1);
      if (idx >= 0 && idx < parsedColors.length) {
        const c = parsedColors[idx];
        faceColors[f * 4] = c[0];
        faceColors[f * 4 + 1] = c[1];
        faceColors[f * 4 + 2] = c[2];
        faceColors[f * 4 + 3] = c[3];
        hasColor = true;
        continue;
      }
    }

    // Default white
    faceColors[f * 4] = 255;
    faceColors[f * 4 + 1] = 255;
    faceColors[f * 4 + 2] = 255;
    faceColors[f * 4 + 3] = 255;
  }

  return hasColor ? faceColors : null;
}

function parseHexColor(hex: string): [number, number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  const a = clean.length >= 8 ? parseInt(clean.substring(6, 8), 16) : 255;
  return [r, g, b, a];
}

function parseCSSColor(css: string): [number, number, number] | null {
  if (!css || !css.startsWith('#')) return null;
  const clean = css.replace('#', '');
  if (clean.length < 6) return null;
  return [
    parseInt(clean.substring(0, 2), 16),
    parseInt(clean.substring(2, 4), 16),
    parseInt(clean.substring(4, 6), 16),
  ];
}

async function readModelXml(zip: JSZip): Promise<string> {
  const paths = ['3D/3dmodel.model', '3D/3dmodel.service'];
  for (const p of paths) {
    const file = zip.file(p);
    if (file) return file.async('text');
  }
  // Fallback: first .model file
  for (const [p, file] of Object.entries(zip.files)) {
    if (!file.dir && p.endsWith('.model')) {
      return file.async('text');
    }
  }
  throw new Error('No 3D model found in 3MF file');
}

function toArray<T>(val: T | T[] | undefined): T[] {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * Count plates in a 3MF file without full geometry parsing.
 */
export async function countPlates(buffer: Buffer): Promise<number> {
  const zip = await JSZip.loadAsync(buffer);
  const parser = new XMLParser(PARSER_OPTIONS);
  const settings = await parseModelSettings(zip, parser);
  return settings.plates.size > 0 ? settings.plates.size : 1;
}

/**
 * Write non-indexed positions as a binary STL file.
 */
export function writePositionsToSTL(positions: Float32Array, filePath: string): void {
  const faceCount = positions.length / 9;
  const buf = Buffer.alloc(84 + faceCount * 50);

  buf.write('Snorcal 3MF Import', 0, 'ascii');
  buf.writeUInt32LE(faceCount, 80);

  for (let f = 0; f < faceCount; f++) {
    const srcOff = f * 9;
    const dstOff = 84 + f * 50;

    const ax = positions[srcOff + 3] - positions[srcOff];
    const ay = positions[srcOff + 4] - positions[srcOff + 1];
    const az = positions[srcOff + 5] - positions[srcOff + 2];
    const bx = positions[srcOff + 6] - positions[srcOff];
    const by = positions[srcOff + 7] - positions[srcOff + 1];
    const bz = positions[srcOff + 8] - positions[srcOff + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    const scale = len > 0 ? 1 / len : 0;

    buf.writeFloatLE(nx * scale, dstOff);
    buf.writeFloatLE(ny * scale, dstOff + 4);
    buf.writeFloatLE(nz * scale, dstOff + 8);

    for (let v = 0; v < 3; v++) {
      const vSrc = srcOff + v * 3;
      const vDst = dstOff + 12 + v * 12;
      buf.writeFloatLE(positions[vSrc], vDst);
      buf.writeFloatLE(positions[vSrc + 1], vDst + 4);
      buf.writeFloatLE(positions[vSrc + 2], vDst + 8);
    }

    buf.writeUInt16LE(0, dstOff + 48);
  }

  fs.writeFileSync(filePath, buf);
}
