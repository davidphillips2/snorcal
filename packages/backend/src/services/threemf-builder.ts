import JSZip from 'jszip';
import { readSTLPositions, deduplicateVertices } from './model-parser.js';
import fs from 'node:fs';

export interface ThreeMFBuildInput {
  stlPath: string;
  faceColors?: Uint8Array; // RGBA per face (4 bytes * faceCount)
  projectSettings?: Record<string, unknown>; // Embedded slicer settings
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

  // 2. Build color group (unique colors)
  const colorGroup: string[] = [];
  const colorIndexMap = new Map<string, number>();

  // Triangle property indices (one per vertex, referencing colorGroup)
  const triProps: number[] = []; // length = indices.length (one per vertex)

  if (input.faceColors && input.faceColors.length > 0) {
    for (let f = 0; f < faceCount; f++) {
      const r = input.faceColors[f * 4];
      const g = input.faceColors[f * 4 + 1];
      const b = input.faceColors[f * 4 + 2];
      const a = input.faceColors[f * 4 + 3];

      // Skip unpainted faces (alpha = 0)
      if (a === 0) {
        triProps.push(0, 0, 0);
        if (colorGroup.length === 0) {
          colorGroup.push('#FFFFFFFF'); // default white
        }
        continue;
      }

      const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(a)}`;
      let idx = colorIndexMap.get(hex);
      if (idx === undefined) {
        idx = colorGroup.length;
        colorIndexMap.set(hex, idx);
        colorGroup.push(hex);
      }
      triProps.push(idx, idx, idx);
    }
  } else {
    // No colors — single default white
    colorGroup.push('#FFFFFFFF');
  }

  // 3. Build 3MF XML model
  const modelXML = buildModelXML(vertices, indices, colorGroup, triProps);

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

  // 5. Package into ZIP
  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXML);
  zip.folder('_rels')!.file('.rels', relsXML);
  zip.folder('3D')!.file('3dmodel.model', modelXML);

  // 6. Embed project settings if provided (slicer reads these from 3MF)
  if (input.projectSettings) {
    zip.folder('Metadata')!.file(
      'project_settings.config',
      JSON.stringify(input.projectSettings, null, 4),
    );
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function buildModelXML(
  vertices: Float32Array,
  indices: Uint32Array,
  colorGroup: string[],
  triProps: number[],
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

  for (let f = 0; f < faceCount; f++) {
    const v1 = indices[f * 3];
    const v2 = indices[f * 3 + 1];
    const v3 = indices[f * 3 + 2];

    if (hasColors) {
      const p1 = triProps[f * 3];
      const p2 = triProps[f * 3 + 1];
      const p3 = triProps[f * 3 + 2];
      xml += `\n          <triangle v1="${v1}" v2="${v2}" v3="${v3}" p1="${p1}" p2="${p2}" p3="${p3}"/>`;
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
