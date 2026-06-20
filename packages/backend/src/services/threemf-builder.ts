import JSZip from 'jszip';
import { readSTLPositions, deduplicateVertices } from './model-parser.js';
import fs from 'node:fs';

// --- Types ---

export type ThreeMFObjectKind = 'model' | 'negative' | 'modifier' | 'support';

export interface ThreeMFModelInput {
  stlPath: string;
  faceColors?: Uint8Array; // RGBA per face (4 bytes * faceCount)
  rotation?: { x: number; y: number; z: number }; // Euler angles in degrees (Three.js Y-up)
  positionOffset?: { x: number; y: number; z: number }; // Three.js Y-up offset
  scale?: { x: number; y: number; z: number };
  mirror?: { x: boolean; y: boolean; z: boolean };
  kind?: ThreeMFObjectKind;
  linkedTo?: number;  // index of parent model entry (negative/modifier → parent model)
  name?: string;
  settings?: Record<string, unknown>; // per-object override (modifier subset)
}

export interface ThreeMFBuildInput {
  // Single model (backwards compat)
  stlPath?: string;
  faceColors?: Uint8Array;
  rotation?: { x: number; y: number; z: number };
  positionOffset?: { x: number; y: number; z: number };
  // Multi-model
  models?: ThreeMFModelInput[];
  // Common
  projectSettings?: Record<string, unknown>;
  buildVolume?: { x: number; y: number; z: number };
}

interface ProcessedGeometry {
  vertices: Float32Array;
  indices: Uint32Array;
  faceCount: number;
}

interface ObjectDef {
  id: number;
  name: string;
  extruder: number;
  vertices: Float32Array;
  indices: Uint32Array;
  kind: ThreeMFObjectKind;
  parentId?: number;
  settings?: Record<string, unknown>;
}

// --- Main builder ---

export async function build3MF(input: ThreeMFBuildInput): Promise<Buffer> {
  // Normalize to model array
  const models: ThreeMFModelInput[] = input.models ?? [{
    stlPath: input.stlPath!,
    faceColors: input.faceColors,
    rotation: input.rotation,
    positionOffset: input.positionOffset,
  }];

  const filamentColours = input.projectSettings?.filament_colour as string[] | undefined;
  const defaultColor = filamentColours?.[0]?.toUpperCase() ?? '#FFFFFF';
  const colorToExtruder = buildColorToExtruderMap(filamentColours);
  const buildVolume = input.buildVolume ?? { x: 270, y: 270, z: 200 };

  // Process each model into 3MF objects (may split by extruder for painted models)
  const allObjects: ObjectDef[] = [];
  const firstObjIdByModelIndex = new Map<number, number>();
  let nextId = 1;

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    const kind: ThreeMFObjectKind = model.kind ?? 'model';
    const name = model.name ?? `model_${mi}`;
    const geo = processModelGeometry(model, buildVolume);

    // Negative/modifier/support volumes never split by paint — single object
    if (kind === 'negative' || kind === 'modifier' || kind === 'support') {
      const parentId = model.linkedTo != null ? firstObjIdByModelIndex.get(model.linkedTo) : undefined;
      const id = nextId++;
      allObjects.push({
        id,
        name,
        extruder: 1,
        vertices: geo.vertices,
        indices: geo.indices,
        kind,
        parentId,
        settings: model.settings,
      });
      // Children don't go in the top-level <components>; they attach via parent
      continue;
    }

    const paintData = processPaintColors(model.faceColors, geo.faceCount, colorToExtruder, defaultColor);
    const hasPaint = model.faceColors && model.faceColors.length > 0 && paintData.some(pc => pc !== null);

    if (hasPaint) {
      // Find unique extruders used
      const extruderFaces = new Map<number, { verts: number[]; idxs: number[] }>();
      for (let f = 0; f < geo.faceCount; f++) {
        const extIdx = paintColorToExtruder(paintData[f]);
        if (!extruderFaces.has(extIdx)) extruderFaces.set(extIdx, { verts: [], idxs: [] });
        const sub = extruderFaces.get(extIdx)!;
        const vMap = new Map<number, number>();
        for (let v = 0; v < 3; v++) {
          const oldIdx = geo.indices[f * 3 + v];
          let newIdx = vMap.get(oldIdx);
          if (newIdx === undefined) {
            newIdx = sub.verts.length / 3;
            vMap.set(oldIdx, newIdx);
            sub.verts.push(
              geo.vertices[oldIdx * 3],
              geo.vertices[oldIdx * 3 + 1],
              geo.vertices[oldIdx * 3 + 2],
            );
          }
          sub.idxs.push(newIdx);
        }
      }

      const sortedKeys = [...extruderFaces.keys()].sort((a, b) => a - b);
      for (const extIdx of sortedKeys) {
        const sub = extruderFaces.get(extIdx)!;
        if (!firstObjIdByModelIndex.has(mi)) firstObjIdByModelIndex.set(mi, nextId);
        allObjects.push({
          id: nextId++,
          name: `${name}_ext${extIdx}`,
          extruder: extIdx + 1,
          vertices: new Float32Array(sub.verts),
          indices: new Uint32Array(sub.idxs),
          kind,
        });
      }
    } else {
      firstObjIdByModelIndex.set(mi, nextId);
      allObjects.push({
        id: nextId++,
        name,
        extruder: 1,
        vertices: geo.vertices,
        indices: geo.indices,
        kind,
      });
    }
  }

  console.log(`[threemf] models=${models.length} objects=${allObjects.length} hasPaint=${allObjects.length > models.length}`);

  // Group children (negative/modifier) by parent object id
  const childrenOf = new Map<number, ObjectDef[]>();
  const topLevelObjects = allObjects.filter(o => o.parentId == null);
  for (const child of allObjects) {
    if (child.parentId == null) continue;
    const arr = childrenOf.get(child.parentId) ?? [];
    arr.push(child);
    childrenOf.set(child.parentId, arr);
  }

  // Build 3MF XML
  const topId = nextId;
  let modelXML = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>`;

  for (const obj of allObjects) {
    modelXML += buildObjectXML(obj, childrenOf.get(obj.id));
  }

  // Top-level component object — references only parent-less objects
  modelXML += `\n    <object id="${topId}" type="model">
      <components>`;
  for (const obj of topLevelObjects) {
    modelXML += `\n        <component objectid="${obj.id}"/>`;
  }
  modelXML += `\n      </components>
    </object>
  </resources>
  <build>
    <item objectid="${topId}"/>
  </build>
</model>`;

  // Build model_settings.config with per-object extruder assignments
  let modelSettingsXML = '';
  if (allObjects.some(o => o.extruder > 1) || allObjects.length > 1) {
    modelSettingsXML = buildModelSettings(allObjects);
  }

  // Package into ZIP
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXML());
  zip.folder('_rels')!.file('.rels', relsXML());
  zip.folder('3D')!.file('3dmodel.model', modelXML);
  if (modelSettingsXML) {
    zip.folder('Metadata')!.file('model_settings.config', modelSettingsXML);
  }
  if (input.projectSettings) {
    const settings = { ...input.projectSettings };
    if (!settings.filament_colour || !Array.isArray(settings.filament_colour) || (settings.filament_colour as string[]).length === 0) {
      settings.filament_colour = ['#FFFFFF'];
    }
    zip.folder('Metadata')!.file('project_settings.config', JSON.stringify(settings, null, 4));
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// --- Geometry processing ---

function processModelGeometry(model: ThreeMFModelInput, buildVolume: { x: number; y: number; z: number }): ProcessedGeometry {
  const rawPositions = readSTLPositions(model.stlPath);
  const { vertices, indices } = deduplicateVertices(rawPositions);
  const faceCount = indices.length / 3;
  const vertexCount = vertices.length / 3;

  // Apply rotation (Euler XYZ in degrees, Three.js Y-up space)
  if (model.rotation && (model.rotation.x !== 0 || model.rotation.y !== 0 || model.rotation.z !== 0)) {
    const deg2rad = Math.PI / 180;
    const rx = model.rotation.x * deg2rad;
    const ry = model.rotation.y * deg2rad;
    const rz = model.rotation.z * deg2rad;
    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);

    for (let i = 0; i < vertexCount; i++) {
      const x = vertices[i * 3], y = vertices[i * 3 + 1], z = vertices[i * 3 + 2];
      const y1 = y * cx - z * sx, z1 = y * sx + z * cx;
      const x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;
      const x3 = x2 * cz - y1 * sz, y3 = x2 * sz + y1 * cz;
      vertices[i * 3] = x3;
      vertices[i * 3 + 1] = y3;
      vertices[i * 3 + 2] = z2;
    }
  }

  // Apply non-uniform scale + per-axis mirror (signed scale)
  const s = model.scale ?? { x: 1, y: 1, z: 1 };
  const m = model.mirror ?? { x: false, y: false, z: false };
  const sx = s.x * (m.x ? -1 : 1);
  const sy = s.y * (m.y ? -1 : 1);
  const sz = s.z * (m.z ? -1 : 1);
  if (sx !== 1 || sy !== 1 || sz !== 1) {
    for (let i = 0; i < vertexCount; i++) {
      vertices[i * 3] *= sx;
      vertices[i * 3 + 1] *= sy;
      vertices[i * 3 + 2] *= sz;
    }
  }

  // Convert Three.js Y-up to 3MF Z-up: (x, y, z) → (x, -z, y)
  for (let i = 0; i < vertexCount; i++) {
    const y = vertices[i * 3 + 1];
    const z = vertices[i * 3 + 2];
    vertices[i * 3 + 1] = -z;
    vertices[i * 3 + 2] = y;
  }

  // Compute bounding box and center on build plate
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const x = vertices[i * 3], y = vertices[i * 3 + 1], z = vertices[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  // Position: center XY on plate, bottom at Z=0, apply user offset
  // Three.js offset (ox, oy, oz) → 3MF offset (ox, -oz, oy)
  const raw = model.positionOffset;
  const offsetX = buildVolume.x / 2 - (minX + maxX) / 2 + (raw?.x ?? 0);
  const offsetY = buildVolume.y / 2 - (minY + maxY) / 2 - (raw?.z ?? 0);
  const offsetZ = -minZ + (raw?.y ?? 0);

  for (let i = 0; i < vertexCount; i++) {
    vertices[i * 3] += offsetX;
    vertices[i * 3 + 1] += offsetY;
    vertices[i * 3 + 2] += offsetZ;
  }

  return { vertices, indices, faceCount };
}

// --- Paint color processing ---

function buildColorToExtruderMap(filamentColours?: string[]): Map<string, number> {
  const map = new Map<string, number>();
  if (filamentColours) {
    for (let i = 0; i < filamentColours.length; i++) {
      map.set(filamentColours[i].toUpperCase(), i + 1);
    }
  }
  return map;
}

function processPaintColors(
  faceColors: Uint8Array | undefined,
  faceCount: number,
  colorToExtruder: Map<string, number>,
  _defaultColor: string,
): (string | null)[] {
  if (!faceColors || faceColors.length === 0) return new Array(faceCount).fill(null);

  const paintColors: (string | null)[] = [];
  for (let f = 0; f < faceCount; f++) {
    const a = faceColors[f * 4 + 3];
    if (a === 0) {
      paintColors.push(null);
      continue;
    }
    const r = faceColors[f * 4], g = faceColors[f * 4 + 1], b = faceColors[f * 4 + 2];
    const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
    const extIdx = colorToExtruder.get(hex) ?? 1;
    paintColors.push(extruderToPaintColor(extIdx));
  }
  return paintColors;
}

/** Decode paint_color string to 0-based extruder index */
function paintColorToExtruder(pc: string | null): number {
  if (pc === '4') return 0;
  if (pc === '8') return 1;
  if (pc) return 0;
  return 0; // unpainted → extruder 0
}

// --- XML builders ---

function kindTo3MFType(kind: ThreeMFObjectKind): string {
  if (kind === 'negative') return 'negative_part';
  if (kind === 'modifier') return 'modifier';
  if (kind === 'support') return 'support_model';
  return 'model';
}

function kindToPartSubtype(kind: ThreeMFObjectKind): string {
  if (kind === 'negative') return 'negative_part';
  if (kind === 'modifier') return 'modifier';
  if (kind === 'support') return 'support_model';
  return 'normal_part';
}

function buildObjectXML(obj: ObjectDef, children?: ObjectDef[]): string {
  const vc = obj.vertices.length / 3;
  const fc = obj.indices.length / 3;
  let xml = `\n    <object id="${obj.id}" type="${kindTo3MFType(obj.kind)}">
      <mesh>
        <vertices>`;
  for (let i = 0; i < vc; i++) {
    xml += `\n          <vertex x="${obj.vertices[i * 3]}" y="${obj.vertices[i * 3 + 1]}" z="${obj.vertices[i * 3 + 2]}"/>`;
  }
  xml += `\n        </vertices>
        <triangles>`;
  for (let f = 0; f < fc; f++) {
    xml += `\n          <triangle v1="${obj.indices[f * 3]}" v2="${obj.indices[f * 3 + 1]}" v3="${obj.indices[f * 3 + 2]}"/>`;
  }
  xml += `\n        </triangles>
      </mesh>`;
  if (children && children.length > 0) {
    xml += `\n      <components>`;
    for (const child of children) {
      xml += `\n        <component objectid="${child.id}"/>`;
    }
    xml += `\n      </components>`;
  }
  xml += `\n    </object>`;
  return xml;
}

function buildModelSettings(objects: ObjectDef[]): string {
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<config>`;
  for (const obj of objects) {
    const fc = obj.indices.length / 3;
    xml += `
  <object id="${obj.id}">
    <metadata key="name" value="${obj.name}"/>
    <metadata key="extruder" value="${obj.extruder}"/>
    <metadata face_count="${fc}"/>
    <part id="${obj.id}" subtype="${kindToPartSubtype(obj.kind)}">
      <metadata key="name" value="${obj.name}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="source_object_id" value="0"/>
      <metadata key="source_volume_id" value="0"/>
      <metadata key="source_offset_x" value="0"/>
      <metadata key="source_offset_y" value="0"/>
      <metadata key="source_offset_z" value="0"/>
      <mesh_stat face_count="${fc}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>`;
    if (obj.settings) {
      for (const [k, v] of Object.entries(obj.settings)) {
        if (v == null) continue;
        xml += `\n      <metadata key="${k}" value="${typeof v === 'string' ? v : JSON.stringify(v)}"/>`;
      }
    }
    xml += `
    </part>
  </object>`;
  }
  xml += `\n</config>`;
  return xml;
}

function contentTypesXML(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
}

function relsXML(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
}

// --- Helpers ---

function toHex(n: number): string {
  return n.toString(16).padStart(2, '0').toUpperCase();
}

/** OrcaSlicer TriangleSelector encoding for non-split leaf triangle */
function extruderToPaintColor(extruderIndex: number): string {
  if (extruderIndex === 1) return '4';
  if (extruderIndex === 2) return '8';
  return (extruderIndex - 3).toString(16).toUpperCase() + 'C';
}

export function writeFaceColors(filePath: string, colors: Uint8Array): void {
  fs.writeFileSync(filePath, Buffer.from(colors));
}

export function readFaceColors(filePath: string): Uint8Array {
  const buf = fs.readFileSync(filePath);
  return new Uint8Array(buf);
}
