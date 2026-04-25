import JSZip from 'jszip';
import { readSTLPositions, deduplicateVertices } from './model-parser.js';
import fs from 'node:fs';

export interface ThreeMFBuildInput {
  stlPath: string;
  faceColors?: Uint8Array; // RGBA per face (4 bytes * faceCount)
  projectSettings?: Record<string, unknown>; // Embedded slicer settings
  rotation?: { x: number; y: number; z: number }; // Euler angles in degrees
  positionOffset?: { x: number; y: number; z: number };
  buildVolume?: { x: number; y: number; z: number };
}

/**
 * Build a 3MF file from an STL with optional per-face color data.
 *
 * 3MF structure:
 *   [Content_Types].xml
 *   _rels/.rels
 *   3D/3dmodel.model  (XML with geometry + material/color extensions)
 */
export async function build3MF(input: ThreeMFBuildInput): Promise<Buffer> {
  // 1. Read and deduplicate STL vertices
  const rawPositions = readSTLPositions(input.stlPath);
  const { vertices, indices } = deduplicateVertices(rawPositions);
  const faceCount = indices.length / 3;

  // 2. Build color group (unique colors) and paint_color extruder mapping
  const colorGroup: string[] = [];
  const colorIndexMap = new Map<string, number>();

  // Default color for unpainted faces: use first filament colour if available, else white
  const filamentColours = input.projectSettings?.filament_colour as string[] | undefined;
  const defaultColor = filamentColours?.[0]?.toUpperCase() ?? '#FFFFFF';

  // Build a map: face hex color → OrcaSlicer extruder index (1-based)
  const colorToExtruder = new Map<string, number>();
  if (filamentColours) {
    for (let i = 0; i < filamentColours.length; i++) {
      colorToExtruder.set(filamentColours[i].toUpperCase(), i + 1); // 1-based
    }
  }

  // Triangle property indices (one per vertex, referencing colorGroup)
  const triProps: number[] = []; // length = indices.length (one per vertex)
  // paint_color per face: OrcaSlicer extruder index (1-based hex)
  const paintColors: (string | null)[] = []; // length = faceCount

  if (input.faceColors && input.faceColors.length > 0) {
    // Ensure default color is in the group first (for unpainted faces → extruder 0)
    const defaultIdx = 0;
    colorGroup.push(defaultColor);
    colorIndexMap.set(defaultColor, defaultIdx);

    for (let f = 0; f < faceCount; f++) {
      const r = input.faceColors[f * 4];
      const g = input.faceColors[f * 4 + 1];
      const b = input.faceColors[f * 4 + 2];
      const a = input.faceColors[f * 4 + 3];

      // Unpainted faces (alpha = 0) → default to first filament/extruder 1
      if (a === 0) {
        triProps.push(defaultIdx, defaultIdx, defaultIdx);
        paintColors.push(null); // no paint_color for unpainted → slicer uses default extruder
        continue;
      }

      const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
      let idx = colorIndexMap.get(hex);
      if (idx === undefined) {
        idx = colorGroup.length;
        colorIndexMap.set(hex, idx);
        colorGroup.push(hex);
      }
      triProps.push(idx, idx, idx);

      // Map to extruder index for paint_color
      const extIdx = colorToExtruder.get(hex) ?? 1; // default to extruder 1 if no match
      paintColors.push(extruderToPaintColor(extIdx));
    }
  } else {
    // No colors — single default
    colorGroup.push(defaultColor);
  }

  // 3. Apply rotation and centering
  const vertexCount = vertices.length / 3;

  // Apply rotation if provided (Euler XYZ in degrees, from Three.js Y-up space)
  const hasRotation = input.rotation && (input.rotation.x !== 0 || input.rotation.y !== 0 || input.rotation.z !== 0);
  if (hasRotation) {
    const deg2rad = Math.PI / 180;
    const rx = input.rotation!.x * deg2rad;
    const ry = input.rotation!.y * deg2rad;
    const rz = input.rotation!.z * deg2rad;

    const cx = Math.cos(rx), sx = Math.sin(rx);
    const cy = Math.cos(ry), sy = Math.sin(ry);
    const cz = Math.cos(rz), sz = Math.sin(rz);

    // Rotation matrix: R = Rz * Ry * Rx (XYZ Euler order, matching Three.js default)
    for (let i = 0; i < vertexCount; i++) {
      const x = vertices[i * 3], y = vertices[i * 3 + 1], z = vertices[i * 3 + 2];
      // Rx
      const y1 = y * cx - z * sx;
      const z1 = y * sx + z * cx;
      // Ry
      const x2 = x * cy + z1 * sy;
      const z2 = -x * sy + z1 * cy;
      // Rz
      const x3 = x2 * cz - y1 * sz;
      const y3 = x2 * sz + y1 * cz;
      vertices[i * 3] = x3;
      vertices[i * 3 + 1] = y3;
      vertices[i * 3 + 2] = z2;
    }
  }

  // Convert from Three.js Y-up to 3MF Z-up: (x, y, z) → (x, -z, y)
  // This ensures the 3MF matches what the user sees in the viewer
  for (let i = 0; i < vertexCount; i++) {
    const y = vertices[i * 3 + 1];
    const z = vertices[i * 3 + 2];
    vertices[i * 3 + 1] = -z;
    vertices[i * 3 + 2] = y;
  }

  // Compute center offset so model sits centered on the build plate
  const plateX = input.buildVolume?.x ?? 270;
  const plateY = input.buildVolume?.y ?? 270;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    const x = vertices[i * 3], y = vertices[i * 3 + 1], z = vertices[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  // Center XY on plate and shift Z so minimum is at 0
  // Position offset from Three.js needs Y→Z conversion: (ox, oy, oz) → (ox, -oz, oy)
  const rawOffset = input.positionOffset;
  const offsetX = plateX / 2 - (minX + maxX) / 2 + (rawOffset?.x ?? 0);
  const offsetY = plateY / 2 - (minY + maxY) / 2 - (rawOffset?.z ?? 0);
  const offsetZ = -minZ + (rawOffset?.y ?? 0);

  // Apply offsets to vertices
  for (let i = 0; i < vertexCount; i++) {
    vertices[i * 3] += offsetX;
    vertices[i * 3 + 1] += offsetY;
    vertices[i * 3 + 2] += offsetZ;
  }

  const modelXML = buildModelXML(vertices, indices, colorGroup, triProps, paintColors);

  // 4. Build supporting XML files
  const contentTypesXML = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

  const relsXML = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

  // 5. Build model_settings.config with paint data for multi-material
  let modelSettingsXML = '';
  if (input.faceColors && input.faceColors.length > 0 && paintColors.some(pc => pc !== null)) {
    // Build paint_color string: one paint_color value per face, space-separated
    // This is stored in model_settings.config as OrcaSlicer reads paint from here, not from 3D model XML
    const paintStr = paintColors.map(pc => pc ?? '0').join(' ');

    modelSettingsXML = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="1">
    <metadata key="name" value="model"/>
    <metadata key="extruder" value="0"/>
    <metadata face_count="${faceCount}"/>
    <part id="1" subtype="normal_part">
      <metadata key="name" value="model"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="source_object_id" value="0"/>
      <metadata key="source_volume_id" value="0"/>
      <metadata key="source_offset_x" value="0"/>
      <metadata key="source_offset_y" value="0"/>
      <metadata key="source_offset_z" value="0"/>
      <mesh_stat face_count="${faceCount}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
      <metadata key="paint_color" value="${paintStr}"/>
    </part>
  </object>
</config>`;
  }

  // 6. Package into ZIP
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXML);
  zip.folder('_rels')!.file('.rels', relsXML);
  zip.folder('3D')!.file('3dmodel.model', modelXML);
  if (modelSettingsXML) {
    zip.folder('Metadata')!.file('model_settings.config', modelSettingsXML);
  }

  // 6. Embed project settings if provided (slicer reads these from 3MF)
  if (input.projectSettings) {
    // Ensure filament_colour is set (OrcaSlicer requires it)
    const settings = { ...input.projectSettings };
    if (!settings.filament_colour || !Array.isArray(settings.filament_colour) || (settings.filament_colour as string[]).length === 0) {
      settings.filament_colour = ['#FFFFFF'];
    }
    zip.folder('Metadata')!.file(
      'project_settings.config',
      JSON.stringify(settings, null, 4),
    );
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function buildModelXML(
  vertices: Float32Array,
  indices: Uint32Array,
  colorGroup: string[],
  triProps: number[],
  paintColors: (string | null)[],
): string {
  const vertexCount = vertices.length / 3;
  const faceCount = indices.length / 3;

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>`;

  // Color group
  if (colorGroup.length > 0) {
    xml += `\n    <m:colorgroup id="1">`;
    for (const color of colorGroup) {
      xml += `\n      <m:color color="${color}"/>`;
    }
    xml += `\n    </m:colorgroup>`;
  }

  // Object with mesh
  xml += `\n    <object id="1" type="model">
      <mesh>
        <vertices>`;

  for (let i = 0; i < vertexCount; i++) {
    xml += `\n          <vertex x="${vertices[i * 3]}" y="${vertices[i * 3 + 1]}" z="${vertices[i * 3 + 2]}"/>`;
  }

  xml += `\n        </vertices>
        <triangles>`;

  const hasColors = triProps.length > 0 && colorGroup.length > 1;
  const hasPaintColors = paintColors.length === faceCount && paintColors.some(pc => pc !== null);

  for (let f = 0; f < faceCount; f++) {
    const v1 = indices[f * 3];
    const v2 = indices[f * 3 + 1];
    const v3 = indices[f * 3 + 2];

    const pc = paintColors[f];
    if (hasColors && pc) {
      const p1 = triProps[f * 3];
      const p2 = triProps[f * 3 + 1];
      const p3 = triProps[f * 3 + 2];
      xml += `\n          <triangle v1="${v1}" v2="${v2}" v3="${v3}" p1="${p1}" p2="${p2}" p3="${p3}" paint_color="${pc}"/>`;
    } else if (hasColors) {
      const p1 = triProps[f * 3];
      const p2 = triProps[f * 3 + 1];
      const p3 = triProps[f * 3 + 2];
      xml += `\n          <triangle v1="${v1}" v2="${v2}" v3="${v3}" p1="${p1}" p2="${p2}" p3="${p3}"/>`;
    } else if (pc) {
      xml += `\n          <triangle v1="${v1}" v2="${v2}" v3="${v3}" paint_color="${pc}"/>`;
    } else {
      xml += `\n          <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`;
    }
  }

  xml += `\n        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1"/>
  </build>
</model>`;

  return xml;
}

function toHex(n: number): string {
  return n.toString(16).padStart(2, '0').toUpperCase();
}

/** OrcaSlicer TriangleSelector encoding for non-split leaf triangle */
function extruderToPaintColor(extruderIndex: number): string {
  if (extruderIndex === 1) return '4';
  if (extruderIndex === 2) return '8';
  return (extruderIndex - 3).toString(16).toUpperCase() + 'C';
}

/**
 * Write face colors to a file for later retrieval.
 */
export function writeFaceColors(filePath: string, colors: Uint8Array): void {
  fs.writeFileSync(filePath, Buffer.from(colors));
}

/**
 * Read face colors from a file.
 */
export function readFaceColors(filePath: string): Uint8Array {
  const buf = fs.readFileSync(filePath);
  return new Uint8Array(buf);
}
