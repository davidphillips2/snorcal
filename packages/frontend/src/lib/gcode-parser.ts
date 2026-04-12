export type MoveType =
  | 'outer_wall'
  | 'inner_wall'
  | 'infill'
  | 'top_surface'
  | 'bottom_surface'
  | 'solid_infill'
  | 'bridge'
  | 'support'
  | 'skirt'
  | 'travel'
  | 'other';

export interface GcodeSegment {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  type: MoveType;
}

export interface GcodeLayerData {
  layerIndex: number;
  zIndex: number;
  height: number;
  segments: GcodeSegment[];
}

export interface ParsedGcode {
  layers: GcodeLayerData[];
  totalLayerCount: number;
  maxZ: number;
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
}

const TYPE_MAP: Record<string, MoveType> = {
  'Outer wall': 'outer_wall',
  'Outer Wall': 'outer_wall',
  'Inner wall': 'inner_wall',
  'Inner Wall': 'inner_wall',
  'Overhang wall': 'inner_wall',
  'Sparse infill': 'infill',
  'Internal infill': 'infill',
  'Top surface': 'top_surface',
  'Top Solid Infill': 'top_surface',
  'Bottom surface': 'bottom_surface',
  'Bottom Solid Infill': 'bottom_surface',
  'Internal solid infill': 'solid_infill',
  'Solid infill': 'solid_infill',
  'Bridge': 'bridge',
  'Internal Bridge': 'bridge',
  'Support': 'support',
  'Support interface': 'support',
  'Support transition': 'support',
  'Skirt': 'skirt',
  'Skirt/Brim': 'skirt',
  'Brim': 'skirt',
  'Wipe tower': 'other',
  'Gap infill': 'infill',
  'Arc fitting': 'other',
  'Unknown': 'other',
};

function parseG1Params(line: string): { x?: number; y?: number; z?: number; e?: number; f?: number } {
  const result: { x?: number; y?: number; z?: number; e?: number; f?: number } = {};
  let i = 3; // skip "G1 "
  const len = line.length;

  while (i < len) {
    const ch = line.charCodeAt(i);
    if (ch === 32) { i++; continue; } // space

    let num = 0;
    let neg = false;
    let hasNum = false;
    i++; // skip letter
    if (i < len && line.charCodeAt(i) === 45) { neg = true; i++; } // '-'
    let dec = -1;
    while (i < len) {
      const c = line.charCodeAt(i);
      if (c >= 48 && c <= 57) { num = num * 10 + (c - 48); hasNum = true; i++; }
      else if (c === 46) { dec = 0; i++; }
      else break;
      if (dec >= 0) dec++;
    }
    if (dec > 0) num /= Math.pow(10, dec);
    if (neg) num = -num;

    if (hasNum || dec >= 0) {
      switch (ch) {
        case 88: result.x = num; break; // X
        case 89: result.y = num; break; // Y
        case 90: result.z = num; break; // Z
        case 69: result.e = num; break; // E
        case 70: result.f = num; break; // F
      }
    }
  }
  return result;
}

export function parseGcode(text: string): ParsedGcode {
  const layers: GcodeLayerData[] = [];
  let currentSegments: GcodeSegment[] = [];
  let currentLayerIndex = 0;
  let currentZ = 0;
  let currentHeight = 0.2;
  let currentType: MoveType = 'other';
  let relativeE = false;

  let curX = 0, curY = 0, curZ = 0, curE = 0;
  let hasFirstLayer = false;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  function pushLayer() {
    if (currentSegments.length > 0 || hasFirstLayer) {
      layers.push({
        layerIndex: currentLayerIndex,
        zIndex: currentZ,
        height: currentHeight,
        segments: currentSegments,
      });
      currentSegments = [];
      currentLayerIndex++;
      hasFirstLayer = false;
    }
  }

  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    if (line.length === 0) continue;
    const first = line.charCodeAt(0);

    if (first === 59) { // ';'
      if (line.startsWith(';TYPE:')) {
        const typeName = line.slice(6).trim();
        currentType = TYPE_MAP[typeName] || 'other';
        continue;
      }
      if (line.startsWith(';LAYER_CHANGE')) {
        pushLayer();
        hasFirstLayer = true;
        continue;
      }
      if (line.startsWith(';Z:')) {
        currentZ = parseFloat(line.slice(3));
        if (currentZ > maxZ) maxZ = currentZ;
        continue;
      }
      if (line.startsWith(';HEIGHT:')) {
        currentHeight = parseFloat(line.slice(8));
        continue;
      }
      continue;
    }

    // M83 = relative E, M82 = absolute E
    if (first === 77) { // 'M'
      if (line.startsWith('M83')) { relativeE = true; continue; }
      if (line.startsWith('M82')) { relativeE = false; continue; }
      continue;
    }

    // G0 = rapid travel move (no extrusion)
    if (first === 71 && line.charCodeAt(1) === 48) { // 'G0'
      const params = parseG1Params(line);
      const newX = params.x !== undefined ? params.x : curX;
      const newY = params.y !== undefined ? params.y : curY;
      const newZ = params.z !== undefined ? params.z : curZ;
      if (params.x !== undefined || params.y !== undefined || params.z !== undefined) {
        currentSegments.push({
          from: { x: curX, y: curZ, z: curY },
          to: { x: newX, y: newZ, z: newY },
          type: 'travel',
        });
      }
      curX = newX; curY = newY; curZ = newZ;
      continue;
    }

    // Only process G1 moves
    if (first !== 71) continue; // 'G'
    if (line.charCodeAt(1) !== 49) continue; // '1'
    if (line.length > 2 && line.charCodeAt(2) !== 32) continue; // must be 'G1 '

    const params = parseG1Params(line);

    const newX = params.x !== undefined ? params.x : curX;
    const newY = params.y !== undefined ? params.y : curY;
    const newZ = params.z !== undefined ? params.z : curZ;

    // Detect extrusion based on E mode
    let isExtrusion = false;
    if (params.e !== undefined) {
      if (relativeE) {
        isExtrusion = params.e > 0;
        curE += params.e;
      } else {
        isExtrusion = params.e > curE;
        curE = params.e;
      }
    }

    if (params.x !== undefined || params.y !== undefined || params.z !== undefined) {
      // Remap: gcode (X, Y, Z) -> Three.js (X, Z, Y) so layers stack up on Y
      const fromX = curX, fromY = curZ, fromZ = curY;
      const toX = newX, toY = newZ, toZ = newY;

      const segType = isExtrusion ? currentType : 'travel';
      currentSegments.push({
        from: { x: fromX, y: fromY, z: fromZ },
        to: { x: toX, y: toY, z: toZ },
        type: segType,
      });

      if (toX < minX) minX = toX;
      if (toY < minY) minY = toY;
      if (toZ < minZ) minZ = toZ;
      if (toX > maxX) maxX = toX;
      if (toY > maxY) maxY = toY;
      if (toZ > maxZ) maxZ = toZ;
    }

    curX = newX;
    curY = newY;
    curZ = newZ;
  }

  // Push remaining segments
  pushLayer();

  // Handle no segments case
  if (layers.length === 0) {
    return {
      layers: [],
      totalLayerCount: 0,
      maxZ: 0,
      bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
    };
  }

  return {
    layers,
    totalLayerCount: layers.length,
    maxZ,
    bounds: {
      minX: minX === Infinity ? 0 : minX,
      minY: minY === Infinity ? 0 : minY,
      minZ: minZ === Infinity ? 0 : minZ,
      maxX: maxX === -Infinity ? 0 : maxX,
      maxY: maxY === -Infinity ? 0 : maxY,
      maxZ: maxZ === -Infinity ? 0 : maxZ,
    },
  };
}
