import JSZip from 'jszip';
import { readSTLPositions, deduplicateVertices } from './model-parser.js';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// --- Local helpers ---

/** Apply Euler XYZ rotation (degrees, Three.js Y-up) to a flat XYZ positions array, in place. */
function applyEulerRotationInPlace(positions: Float32Array, rotation: { x: number; y: number; z: number }): void {
  const deg2rad = Math.PI / 180;
  const rx = rotation.x * deg2rad;
  const ry = rotation.y * deg2rad;
  const rz = rotation.z * deg2rad;
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  const vertexCount = positions.length / 3;
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const y1 = y * cx - z * sx, z1 = y * sx + z * cx;
    const x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;
    const x3 = x2 * cz - y1 * sz, y3 = x2 * sz + y1 * cz;
    positions[i * 3] = x3;
    positions[i * 3 + 1] = y3;
    positions[i * 3 + 2] = z2;
  }
}

// --- Types ---

export type ThreeMFObjectKind = 'model' | 'part' | 'negative' | 'modifier' | 'support';

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
  /** Translation applied to place geometry on the build plate (3MF Z-up space).
   *  Children (negative/modifier) reuse this so they track the parent. */
  offset: { x: number; y: number; z: number };
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
  // Per-triangle OrcaSlicer paint_color strings ('5C','6C',...). null = unpainted.
  // When present, buildObjectXML emits paint_color="..." on each <triangle>.
  paintData?: (string | null)[];
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

  const filamentColors = input.projectSettings?.filament_colour as string[] | undefined;
  const defaultColor = filamentColors?.[0]?.toUpperCase() ?? '#FFFFFF';
  const colorToExtruder = buildColorToExtruderMap(filamentColors);
  const buildVolume = input.buildVolume ?? { x: 270, y: 270, z: 200 };

  // Process each model into 3MF objects (may split by extruder for painted models)
  const allObjects: ObjectDef[] = [];
  const firstObjIdByModelIndex = new Map<number, number>();
  // Track each parent model's plate-centering offset so children (negatives /
  // modifiers) can be translated by the same amount and stay glued to parent.
  const offsetByModelIndex = new Map<number, { x: number; y: number; z: number }>();
  let nextId = 1;

  // Pre-scan: identify which parent model indices have at least one printable
  // `kind='part'` child. Those parents skip their own merged-mesh emission —
  // their parts ARE the printable geometry (avoids duplicating the assembly's
  // triangles in the output 3MF).
  const parentsWithParts = new Set<number>();
  for (const m of models) {
    if ((m.kind === 'part') && m.linkedTo != null) parentsWithParts.add(m.linkedTo);
  }

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    const kind: ThreeMFObjectKind = model.kind ?? 'model';
    const name = model.name ?? `model_${mi}`;

    // Negative/modifier/support volumes never split by paint — single object.
    // Skip plate-centering: reuse parent's offset so the cutter stays put
    // relative to the parent mesh (otherwise the slicer sees the cutter
    // floating somewhere unrelated, producing wrong layer counts / previews).
    if (kind === 'negative' || kind === 'modifier' || kind === 'support') {
      const parentId = model.linkedTo != null ? firstObjIdByModelIndex.get(model.linkedTo) : undefined;
      const parentOffset = model.linkedTo != null ? offsetByModelIndex.get(model.linkedTo) : undefined;
      const geo = processChildGeometry(
        model.stlPath,
        parentOffset,
        model.rotation,
        model.scale,
        model.mirror,
      );
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

    // Printable parts of an assembly (kind='part') — printable geometry that
    // belongs to a parent. Same no-centering rule as negatives (reuse parent's
    // offset so the part stays glued inside the assembly). Distinct from
    // negatives: emitted as `<object type="model">` with subtype `normal_part`.
    if (kind === 'part') {
      const parentId = model.linkedTo != null ? firstObjIdByModelIndex.get(model.linkedTo) : undefined;
      const parentOffset = model.linkedTo != null ? offsetByModelIndex.get(model.linkedTo) : undefined;
      const geo = processChildGeometry(
        model.stlPath,
        parentOffset,
        model.rotation,
        model.scale,
        model.mirror,
      );
      const paintData = processPaintColors(model.faceColors, geo.faceCount, colorToExtruder, defaultColor);
      const hasPaint = model.faceColors && model.faceColors.length > 0 && paintData.some(pc => pc !== null);
      const id = nextId++;
      allObjects.push({
        id,
        name,
        extruder: 1,
        vertices: geo.vertices,
        indices: geo.indices,
        kind,
        parentId,
        paintData: hasPaint ? paintData : undefined,
      });
      continue;
    }

    // Parent has printable parts? Skip emitting the merged `plate_1.stl` —
    // its triangles are already represented by the per-part STLs, and
    // emitting both makes the slicer see double geometry. The wrapper object
    // at topId still groups the parts into a single assembly.
    if (parentsWithParts.has(mi)) {
      // Reserve an id so children with linkedTo=mi can still resolve a
      // parentId (used only for model_settings.config bookkeeping).
      if (!firstObjIdByModelIndex.has(mi)) firstObjIdByModelIndex.set(mi, nextId++);
      // No geometry push — parent is an assembly container, not a mesh.
      continue;
    }

    const geo = processModelGeometry(model, buildVolume);
    offsetByModelIndex.set(mi, geo.offset);

    const paintData = processPaintColors(model.faceColors, geo.faceCount, colorToExtruder, defaultColor);
    const hasPaint = model.faceColors && model.faceColors.length > 0 && paintData.some(pc => pc !== null);

    // OrcaSlicer expects painted faces encoded as per-triangle paint_color
    // attributes on a SINGLE mesh object — NOT split into one object per
    // extruder. Splitting produces non-manifold sub-meshes that OrcaSlicer
    // rejects with "found slicing or export error".
    if (!firstObjIdByModelIndex.has(mi)) firstObjIdByModelIndex.set(mi, nextId);
    allObjects.push({
      id: nextId++,
      name,
      extruder: 1,
      vertices: geo.vertices,
      indices: geo.indices,
      kind,
      paintData: hasPaint ? paintData : undefined,
    });
  }

  // Build 3MF XML matching Bambu Studio's structure (verified against
  // /tmp/good-3mf reference, BambuStudio-02.07.01.57 P1S multi-color export):
  //   - root <model> carries xmlns:BambuStudio + xmlns:p + requiredextensions="p"
  //   - <metadata> blocks (Application, BambuStudio:3mfVersion, dates)
  //   - p:UUID on every <object>, <component>, <build>, <item>
  //   - transform="1 0 0 0 0 1 0 0 0 0 1 0" (identity 4x3) on <component>/<item>
  //   - printable="1" on <item>
  // Geometry stays inline (snorcal doesn't emit external /3D/Objects/ files
  // yet — slicer accepts both patterns per 3MF core spec).
  const topId = nextId;
  const topUuid = randomUUID();
  const buildUuid = randomUUID();
  const itemUuid = randomUUID();
  const componentUuids = new Map<number, string>();
  for (const obj of allObjects) componentUuids.set(obj.id, randomUUID());

  const today = new Date().toISOString().slice(0, 10);

  let modelXML = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"
  xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"
  requiredextensions="p">
  <metadata name="Application">Snorcal-1.0</metadata>
  <metadata name="BambuStudio:3mfVersion">1</metadata>
  <metadata name="CreationDate">${today}</metadata>
  <metadata name="ModificationDate">${today}</metadata>
  <metadata name="Title"></metadata>
  <metadata name="Description"></metadata>
  <metadata name="Designer"></metadata>
  <metadata name="License"></metadata>
  <resources>`;

  for (const obj of allObjects) {
    modelXML += buildObjectXML(obj, componentUuids);
  }

  // Top-level component object — references every object (parent + children).
  // NOTE: <component> has NO transform attribute. Bisect found that any
  // component transform (even identity "1 0 0 0 0 1 0 0 0 0 1 0") makes
  // BambuStudio slicer emit "no layers detected" + exit 156. Snorcal
  // pre-bakes centering into vertex coords (processModelGeometry), so the
  // component reference is identity-positioned by default. Bambu Studio's
  // own exports use component transform because geometry stays in
  // object-space — different pipeline, different requirement.
  modelXML += `\n    <object id="${topId}" p:UUID="${topUuid}" type="model">
      <components>`;
  for (const obj of allObjects) {
    modelXML += `\n        <component objectid="${obj.id}" p:UUID="${componentUuids.get(obj.id)}"/>`;
  }
  modelXML += `\n      </components>
    </object>
  </resources>
  <build p:UUID="${buildUuid}">
    <item objectid="${topId}" p:UUID="${itemUuid}" transform="1 0 0 0 0 1 0 0 0 0 1 0" printable="1"/>
  </build>
</model>`;

  // Always emit model_settings.config (bambuddy parity — Bambu Studio always
  // emits it). Previous conditional emission skipped single-painted-model
  // case; regression noted 2026-06-25 was for extruder=N>1, not for presence
  // of the file itself. Part extruder stays at 1 (or 0 for non-printable),
  // paint_color carries multi-color assignment.
  const modelSettingsXML = buildModelSettings(allObjects, topId);

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
    zip.folder('Metadata')!.file('project_settings.config', JSON.stringify(settings, null, 4) + '\n');
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
    applyEulerRotationInPlace(vertices, model.rotation);
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

  return { vertices, indices, faceCount, offset: { x: offsetX, y: offsetY, z: offsetZ } };
}

/**
 * Apply a parent model's translation to a child mesh (negative/modifier) so
 * the child tracks the parent across plate-centering + user offsets. Child
 * geometry is expected to already be in 3MF Z-up space (i.e. read from STL
 * written by writePositionsToSTL where Y/Z are already swapped).
 */
function applyParentOffset(vertices: Float32Array, offset: { x: number; y: number; z: number }): void {
  for (let i = 0; i < vertices.length; i += 3) {
    vertices[i] += offset.x;
    vertices[i + 1] += offset.y;
    vertices[i + 2] += offset.z;
  }
}

/**
 * Process a child mesh (negative/modifier/support) that must follow its
 * parent's placement. Applies per-part rotation → scale/mirror in Three.js
 * Y-up space (same pipeline as processModelGeometry), then Y-up → Z-up swap,
 * then the parent's plate-centering offset. MakerWorld embedded negatives
 * have identity transforms so this is a no-op for them; user-uploaded
 * cutters honor rotation/scale/mirror from the per-row TransformPanel.
 */
function processChildGeometry(
  stlPath: string,
  parentOffset?: { x: number; y: number; z: number },
  rotation?: { x: number; y: number; z: number },
  scale?: { x: number; y: number; z: number },
  mirror?: { x: boolean; y: boolean; z: boolean },
): ProcessedGeometry {
  const rawPositions = readSTLPositions(stlPath);
  const { vertices, indices } = deduplicateVertices(rawPositions);
  const faceCount = indices.length / 3;
  const vertexCount = vertices.length / 3;

  // Apply rotation (Euler XYZ in degrees, Three.js Y-up space)
  if (rotation && (rotation.x !== 0 || rotation.y !== 0 || rotation.z !== 0)) {
    applyEulerRotationInPlace(vertices, rotation);
  }

  // Apply non-uniform scale + per-axis mirror (signed scale)
  const s = scale ?? { x: 1, y: 1, z: 1 };
  const m = mirror ?? { x: false, y: false, z: false };
  const ssx = s.x * (m.x ? -1 : 1);
  const ssy = s.y * (m.y ? -1 : 1);
  const ssz = s.z * (m.z ? -1 : 1);
  if (ssx !== 1 || ssy !== 1 || ssz !== 1) {
    for (let i = 0; i < vertexCount; i++) {
      vertices[i * 3] *= ssx;
      vertices[i * 3 + 1] *= ssy;
      vertices[i * 3 + 2] *= ssz;
    }
  }

  // Convert Three.js Y-up to 3MF Z-up: (x, y, z) → (x, -z, y)
  for (let i = 0; i < vertexCount; i++) {
    const y = vertices[i * 3 + 1];
    const z = vertices[i * 3 + 2];
    vertices[i * 3 + 1] = -z;
    vertices[i * 3 + 2] = y;
  }

  const offset = parentOffset ?? { x: 0, y: 0, z: 0 };
  if (offset.x !== 0 || offset.y !== 0 || offset.z !== 0) {
    applyParentOffset(vertices, offset);
  }

  return { vertices, indices, faceCount, offset };
}

/** Decode a paint_color string to its 1-based extruder index (0 = unpainted). */
function paintColorToExtruder(pc: string | null): number {
  if (!pc) return 0;
  if (pc === '4') return 1;
  if (pc === '8') return 2;
  // "{N-3}C" → state N ≥ 3 → extruder N
  const m = /^([0-9A-F])C$/i.exec(pc);
  if (m) return parseInt(m[1], 16) + 3;
  return 0;
}

/** True if paintData assigns faces to >1 distinct extruder (i.e. multi-colour). */
function isMultiColorPaint(paintData: (string | null)[] | undefined): boolean {
  if (!paintData || paintData.length === 0) return false;
  const seen = new Set<number>();
  for (const pc of paintData) {
    if (!pc) continue;
    seen.add(paintColorToExtruder(pc));
    if (seen.size > 1) return true;
  }
  return false;
}

// --- Paint color processing ---

/** Normalize hex (#RRGGBB / #RRGGBBAA / RRGGBB / RRGGBBAA) → uppercase #RRGGBB.
 *  Painted face RGB (6 hex) must match filament_colour RGBA (8 hex) for the
 *  color→extruder lookup; without normalization every lookup misses and all
 *  faces fall back to extruder 1, producing single-color output. */
function normalizeHex(c: string): string {
  let s = c.trim().toUpperCase().replace(/^#/, '');
  if (s.length === 8) s = s.slice(0, 6);
  return s.length === 6 ? '#' + s : '#' + s;
}

function buildColorToExtruderMap(filamentColors?: string[]): Map<string, number> {
  const map = new Map<string, number>();
  if (filamentColors) {
    for (let i = 0; i < filamentColors.length; i++) {
      // First occurrence wins — OrcaSlicer pads filament_colour to machine
      // extruder count by repeating the last entry, which would otherwise
      // overwrite the real slot index (e.g. [#FF0000,#0000FF,#0000FF,#0000FF]
      // would map blue → 4 instead of 2).
      const key = normalizeHex(filamentColors[i]);
      if (!map.has(key)) map.set(key, i + 1);
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
  // Guard: if face-color buffer is shorter than geometry's face count (e.g.
  // paint was authored against a different mesh), skip painting for OOB faces
  // rather than throwing on undefined.toString().
  const availableFaces = Math.floor(faceColors.length / 4);
  const usableFaceCount = Math.min(faceCount, availableFaces);
  for (let f = 0; f < faceCount; f++) {
    if (f >= usableFaceCount) {
      paintColors.push(null);
      continue;
    }
    const a = faceColors[f * 4 + 3];
    if (a === 0) {
      paintColors.push(null);
      continue;
    }
    const r = faceColors[f * 4], g = faceColors[f * 4 + 1], b = faceColors[f * 4 + 2];
    const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    const extIdx = colorToExtruder.get(hex) ?? 1;
    paintColors.push(extruderToPaintColor(extIdx));
  }
  return paintColors;
}

// --- XML builders ---

function kindTo3MFType(kind: ThreeMFObjectKind): string {
  // 3MF core spec only allows @type = "model" | "other" | "support".
  // Bambu/Orca object roles (negative_part, modifier, support_model) live in
  // model_settings.config via <part subtype="...">, NOT on the <object> tag.
  // Emitting type="negative_part" makes OrcaSlicer reject the 3MF with
  // "Found invalid object" at parse time.
  if (kind === 'negative' || kind === 'modifier' || kind === 'support') return 'other';
  // 'model' (top-level parent) and 'part' (printable child) both emit as
  // printable model objects — distinction between them lives in
  // model_settings.config via subtype.
  return 'model';
}

function kindToPartSubtype(kind: ThreeMFObjectKind): string {
  if (kind === 'negative') return 'negative_part';
  if (kind === 'modifier') return 'modifier';
  if (kind === 'support') return 'support_model';
  // 'model' (parent) and 'part' (printable child) both render as normal_part.
  return 'normal_part';
}

function buildObjectXML(obj: ObjectDef, uuidMap: Map<number, string>): string {
  const vc = obj.vertices.length / 3;
  const fc = obj.indices.length / 3;
  const uuid = uuidMap.get(obj.id)!;
  let xml = `\n    <object id="${obj.id}" p:UUID="${uuid}" type="${kindTo3MFType(obj.kind)}">
      <mesh>
        <vertices>`;
  for (let i = 0; i < vc; i++) {
    xml += `\n          <vertex x="${obj.vertices[i * 3]}" y="${obj.vertices[i * 3 + 1]}" z="${obj.vertices[i * 3 + 2]}"/>`;
  }
  xml += `\n        </vertices>
        <triangles>`;
  for (let f = 0; f < fc; f++) {
    const pc = obj.paintData?.[f];
    if (pc) {
      // OrcaSlicer reads Bambu's `paint_color` attribute per-triangle.
      // pc is the per-face encoded value from extruderToPaintColor().
      xml += `\n          <triangle v1="${obj.indices[f * 3]}" v2="${obj.indices[f * 3 + 1]}" v3="${obj.indices[f * 3 + 2]}" paint_color="${pc}"/>`;
    } else {
      xml += `\n          <triangle v1="${obj.indices[f * 3]}" v2="${obj.indices[f * 3 + 1]}" v3="${obj.indices[f * 3 + 2]}"/>`;
    }
  }
  xml += `\n        </triangles>
      </mesh>`;
  xml += `\n    </object>`;
  return xml;
}

function buildModelSettings(objects: ObjectDef[], wrapperId: number): string {
  // Bambu Studio reference structure (/tmp/good-3mf, BambuStudio-02.07.01.57):
  //   <object id=N> wraps all parts + carries object-level name/extruder/face_count
  //   <part> entries carry matrix (12-value 4x3), source_file, source_offset, extruder
  //   <plate> carries plater_name, locked, filament_map_mode, thumbnail refs
  //   <model_instance> carries instance_id + identify_id
  //   <assemble></assemble> present (empty for single-object)
  const totalFaceCount = objects.reduce((sum, o) => sum + o.indices.length / 3, 0);
  const wrapperName = objects[0]?.name ?? 'model';

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${wrapperId}">
    <metadata key="name" value="${wrapperName}"/>
    <metadata key="extruder" value="1"/>
    <metadata face_count="${totalFaceCount}"/>`;
  for (const obj of objects) {
    const fc = obj.indices.length / 3;
    // Negative/modifier/support parts use extruder="0" (BambuStudio sentinel
    // for "no filament"); printable parts (model parent + part children) use
    // their assigned extruder.
    const partExtruder = (obj.kind === 'model' || obj.kind === 'part') ? obj.extruder : 0;
    xml += `
    <part id="${obj.id}" subtype="${kindToPartSubtype(obj.kind)}">
      <metadata key="name" value="${obj.name}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="source_file" value="${obj.name}.stl"/>
      <metadata key="source_object_id" value="0"/>
      <metadata key="source_volume_id" value="0"/>
      <metadata key="source_offset_x" value="0"/>
      <metadata key="source_offset_y" value="0"/>
      <metadata key="source_offset_z" value="0"/>
      <metadata key="extruder" value="${partExtruder}"/>
      <mesh_stat face_count="${fc}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>`;
    if (obj.settings) {
      for (const [k, v] of Object.entries(obj.settings)) {
        if (v == null) continue;
        xml += `\n      <metadata key="${k}" value="${typeof v === 'string' ? v : JSON.stringify(v)}"/>`;
      }
    }
    xml += `
    </part>`;
  }
  xml += `
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="Plate 1"/>
    <metadata key="locked" value="false"/>
    <metadata key="filament_map_mode" value="Auto For Flush"/>
    <metadata key="gcode_file" value=""/>
    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>
    <metadata key="thumbnail_no_light_file" value="Metadata/plate_no_light_1.png"/>
    <metadata key="top_file" value="Metadata/top_1.png"/>
    <metadata key="pick_file" value="Metadata/pick_1.png"/>
    <model_instance>
      <metadata key="object_id" value="${wrapperId}"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="1"/>
    </model_instance>
  </plate>
  <assemble>
  </assemble>
</config>`;
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

/**
 * Encode extruder index (1-based) as OrcaSlicer paint_color value.
 * Format: TriangleSelector bitstream (TriangleSelector.cpp serialize).
 *   state 1 → "4", state 2 → "8", state N≥3 → "{N-3}C"
 * Tested: 5C/6C/7C form (Bambu Studio output) is NOT read by local
 * OrcaSlicer 2.4.0 — slices all-white because it parses those as
 * extruders 8/9/10 which aren't configured.
 */
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
