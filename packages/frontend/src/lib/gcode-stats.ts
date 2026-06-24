/**
 * Per-`;TYPE:` time breakdown for gcode.
 *
 * Walks G0/G1 moves, accumulates cartesian move time per type section.
 * Feedrate is mm/min in gcode; we convert to mm/s. Travel + extrusion
 * moves both counted (we don't differentiate — both consume time). E-only
 * moves (retract/unretract) use E-axis distance.
 *
 * Honours M83/M82 (relative/absolute E) and G90/G91 for XYZ.
 * Ignores moves before first ;TYPE:.
 */

export interface TypeBreakdownEntry {
  type: string;
  seconds: number;
  /** 0..1 share of total time across all reported types. */
  fraction: number;
}

const TYPE_COLORS: Record<string, string> = {
  custom: '#888888',
  'outer wall': '#ff3030',
  'inner wall': '#ff8c1a',
  'top surface': '#ffd700',
  'bottom surface': '#ffea66',
  'solid skin': '#ffd700',
  'sparse infill': '#33cc33',
  'internal solid infill': '#2da32d',
  bridge: '#33cccc',
  'internal bridge': '#33cccc',
  support: '#9933cc',
  'support interface': '#cc66ff',
  'support transition': '#cc66ff',
  skirt: '#888888',
  brim: '#888888',
  'prime tower': '#ff66cc',
  'wipe tower': '#ff66cc',
  'gap infill': '#66cc66',
  ironing: '#cc99cc',
};

export function typeColor(type: string): string {
  return TYPE_COLORS[type.toLowerCase()] ?? '#9ca3af';
}

export function analyzeGcodeTime(gcode: string): TypeBreakdownEntry[] {
  const lines = gcode.split('\n');

  let currentType = 'custom';
  let feedMmS = 0;
  let x = 0, y = 0, z = 0, e = 0;
  let absoluteE = false; // M82 default in many slicers; Snapmaker Orca uses M83
  let absoluteXYZ = true; // G90 default

  const typeSeconds = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // Comment-only line — may carry ;TYPE:
    const semi = line.indexOf(';');
    const codePart = semi >= 0 ? line.slice(0, semi) : line;
    const commentPart = semi >= 0 ? line.slice(semi + 1) : '';

    if (commentPart) {
      const typeMatch = commentPart.match(/^TYPE:\s*(.+)/i);
      if (typeMatch) {
        currentType = typeMatch[1].trim().toLowerCase();
        if (!typeSeconds.has(currentType)) typeSeconds.set(currentType, 0);
      }
    }

    const trimmedCode = codePart.trim();
    if (!trimmedCode) continue;

    // Modal motion commands only
    if (!/^(G0|G1|G00|G01)\b/.test(trimmedCode)) {
      // Mode switches
      if (/^M82\b/.test(trimmedCode)) absoluteE = true;
      else if (/^M83\b/.test(trimmedCode)) absoluteE = false;
      else if (/^G90\b/.test(trimmedCode)) absoluteXYZ = true;
      else if (/^G91\b/.test(trimmedCode)) absoluteXYZ = false;
      continue;
    }

    // Parse F X Y Z E from the move
    const fMatch = trimmedCode.match(/F(\d+(?:\.\d+)?)/i);
    if (fMatch) feedMmS = parseFloat(fMatch[1]) / 60;
    if (feedMmS <= 0) continue;

    let nx = x, ny = y, nz = z, ne = e;
    const xMatch = trimmedCode.match(/X(-?\d+(?:\.\d+)?)/i);
    const yMatch = trimmedCode.match(/Y(-?\d+(?:\.\d+)?)/i);
    const zMatch = trimmedCode.match(/Z(-?\d+(?:\.\d+)?)/i);
    const eMatch = trimmedCode.match(/E(-?\d+(?:\.\d+)?)/i);
    if (xMatch) nx = parseFloat(xMatch[1]) * (absoluteXYZ ? 1 : 1) + (absoluteXYZ ? 0 : x);
    if (yMatch) ny = parseFloat(yMatch[1]) * (absoluteXYZ ? 1 : 1) + (absoluteXYZ ? 0 : y);
    if (zMatch) nz = parseFloat(zMatch[1]) * (absoluteXYZ ? 1 : 1) + (absoluteXYZ ? 0 : z);
    if (eMatch) {
      const ev = parseFloat(eMatch[1]);
      ne = absoluteE ? ev : e + ev;
    }

    const dx = nx - x, dy = ny - y, dz = nz - z, de = ne - e;
    const xyzDist = Math.hypot(dx, dy, dz);
    const eDist = Math.abs(de);
    // Use cartesian distance; if pure E move (retract), use E distance
    const dist = xyzDist > 1e-6 ? xyzDist : eDist;
    if (dist <= 0) { x = nx; y = ny; z = nz; e = ne; continue; }

    const seconds = dist / feedMmS;
    typeSeconds.set(currentType, (typeSeconds.get(currentType) ?? 0) + seconds);

    x = nx; y = ny; z = nz; e = ne;
  }

  const total = Array.from(typeSeconds.values()).reduce((a, b) => a + b, 0);
  return Array.from(typeSeconds.entries())
    .map(([type, seconds]) => ({ type, seconds, fraction: total > 0 ? seconds / total : 0 }))
    .sort((a, b) => b.seconds - a.seconds);
}

/**
 * Parse `; estimated printing time (normal mode) = 2h 0m 54s` from a slicer
 * header. Returns null if not found. Used as the authoritative total since
 * the parser-based sum ignores acceleration/jerk and undercounts ~40%.
 */
export function parseSlicerEstimatedTime(gcode: string): number | null {
  const m = gcode.match(/;\s*estimated printing time[^=\n]*=\s*(\d+h)?\s*(\d+m)?\s*(\d+s)?/i);
  if (!m) return null;
  const h = parseInt(m[1] ?? '0', 10) || 0;
  const min = parseInt(m[2] ?? '0', 10) || 0;
  const s = parseInt(m[3] ?? '0', 10) || 0;
  const total = h * 3600 + min * 60 + s;
  return total > 0 ? total : null;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Walk gcode, map each `;LAYER_CHANGE` (or `;LAYER:N`) marker to the dominant
 * `;TYPE:` that follows until the next layer marker. Used by the layer
 * filmstrip to color ticks by section.
 */
export function extractLayerTypes(gcode: string): Map<number, string> {
  const out = new Map<number, string>();
  const typeCounts = new Map<string, number>();
  let currentLayer = 0;
  let pendingLayer: number | null = null;

  const flush = () => {
    if (pendingLayer === null) return;
    let dominant = '';
    let max = 0;
    for (const [t, c] of typeCounts) if (c > max) { max = c; dominant = t; }
    if (dominant) out.set(pendingLayer, dominant);
    pendingLayer = null;
    typeCounts.clear();
  };

  for (const rawLine of gcode.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith(';')) {
      // Count ;TYPE: only matters for non-comment moves; we just need the current type
      continue;
    }
    const layerMatch = line.match(/^;LAYER(?:_CHANGE)?:?\s*(\d+)/i);
    if (layerMatch) {
      flush();
      pendingLayer = parseInt(layerMatch[1], 10);
      currentLayer = pendingLayer ?? currentLayer;
      continue;
    }
    const typeMatch = line.match(/^;TYPE:\s*(.+)/i);
    if (typeMatch) {
      const t = typeMatch[1].trim().toLowerCase();
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }
  }
  flush();
  return out;
}
