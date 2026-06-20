import fs from 'node:fs';

export interface FilamentInfo {
  index: number;       // 0-based filament index in gcode
  color: string | null;   // hex '#RRGGBB' or null
  type: string | null;    // 'PLA', 'PETG', ...
  weightG: number | null; // grams
  used: boolean;       // true if a Tx tool change references this filament
}

/**
 * Parse a slicer-generated gcode file for filament metadata.
 * Supports OrcaSlicer / BambuStudio header formats:
 *   ; filament_type: ["PLA","PETG"]
 *   ; filament_colour: ["#FF0000","#0000FF"]
 *   ; filament used [g] [m] [name] [name2]
 * Plus which filaments are actually referenced via T-codes (T0, T1, ...).
 */
export function parseGcodeFilaments(gcodePath: string): FilamentInfo[] {
  if (!fs.existsSync(gcodePath)) return [];

  // Read just the header (first 64KB usually has metadata) plus scan body for T-codes
  const fd = fs.openSync(gcodePath, 'r');
  const HEADER_BYTES = 256 * 1024;
  const headerBuf = Buffer.alloc(HEADER_BYTES);
  const headerLen = fs.readSync(fd, headerBuf, 0, HEADER_BYTES, 0);

  // For T-code scan: stream through file in 1MB chunks, find max T index used
  const tUsedSet = new Set<number>();
  const scanBuf = Buffer.alloc(1024 * 1024);
  let leftover = '';
  let pos = 0;
  while (true) {
    const n = fs.readSync(fd, scanBuf, 0, scanBuf.length, pos);
    if (n === 0) break;
    const chunk = leftover + scanBuf.toString('utf8', 0, n);
    // Match tool changes at start of line: T0, T1, ... T9 (T<n> at line start)
    // Some gcodes have T0..T15 for big AMS installations.
    const matches = chunk.matchAll(/(?:^|\n)T(\d+)\b/g);
    for (const m of matches) tUsedSet.add(parseInt(m[1], 10));
    // Keep tail to avoid split-miss
    leftover = chunk.slice(-4);
    pos += n;
    if (n < scanBuf.length) break;
  }
  fs.closeSync(fd);

  const headerStr = headerBuf.toString('utf8', 0, headerLen);

  // Parse JSON-array form (newer OrcaSlicer/Bambu)
  const types = parseJsonArray(headerStr, /; ?filament_type:\s*(.+)/);
  const colors = parseJsonArray(headerStr, /; ?filament_colour:\s*(.+)/);

  // Parse "filament used" — OrcaSlicer uses `; filament used [g] [m] ...`
  // The first array is grams. Some use `; filament used [mm] [g]` — second is grams.
  let weights: (number | null)[] | null = null;
  const usedMatch = headerStr.match(/; ?filament used \[g\][^\n]*?:\s*\[([^\]]+)\]/i);
  if (usedMatch) {
    weights = usedMatch[1].split(',').map(s => {
      const n = parseFloat(s.trim());
      return isNaN(n) ? null : n;
    });
  } else {
    // Fallback: `; filament used [mm] [g]` — second array
    const m2 = headerStr.match(/; ?filament used \[mm\][^[]*\[[^\]]+\]\s*\[([^\]]+)\]/i);
    if (m2) {
      weights = m2[1].split(',').map(s => {
        const n = parseFloat(s.trim());
        return isNaN(n) ? null : n;
      });
    }
  }

  // Determine count: max(tUsed + 1, types.length, colors.length)
  const tCount = tUsedSet.size > 0 ? Math.max(...tUsedSet) + 1 : 0;
  const arrCount = Math.max(types?.length ?? 0, colors?.length ?? 0);
  const count = Math.max(tCount, arrCount);
  if (count === 0) return [];

  const out: FilamentInfo[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      index: i,
      color: colors?.[i] ?? null,
      type: types?.[i] ?? null,
      weightG: weights?.[i] ?? null,
      used: tUsedSet.has(i),
    });
  }
  return out;
}

function parseJsonArray(src: string, re: RegExp): string[] | null {
  const m = src.match(re);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1].trim());
    if (Array.isArray(arr)) return arr.map(String);
  } catch { /* not JSON, try comma split */ }
  const inner = m[1].match(/\[([^\]]+)\]/);
  if (inner) {
    return inner[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
  }
  return null;
}
