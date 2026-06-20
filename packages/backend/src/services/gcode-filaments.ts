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
 *
 * Supports three header dialects:
 *   - OrcaSlicer (current): `; filament_type = PLA` (scalar) or ` = ["PLA","PETG"]`
 *   - OrcaSlicer/Bambu (legacy): `; filament_type: ["PLA","PETG"]`
 *   - Mixed: separator may be `:` or ` = `, value may be scalar, JSON array,
 *     or bracketed list.
 *
 * Weight formats:
 *   - `; filament used [g] = 5.83` (scalar)
 *   - `; filament used [g]: [5.83, 7.2]` (array)
 *
 * T-code scan: only counts T0–T15 as real tool changes. Bambu firmware uses
 * T1000 (load) / T255 (unload) as slot macros — those don't correspond to
 * filament indices and must be excluded.
 */
export function parseGcodeFilaments(gcodePath: string): FilamentInfo[] {
  if (!fs.existsSync(gcodePath)) return [];

  // Read header (first 256KB) for filament_type/colour metadata +
  // tail (last 64KB) for filament-used summaries (always at end of file).
  const fd = fs.openSync(gcodePath, 'r');
  const stat = fs.fstatSync(fd);
  const HEADER_BYTES = 256 * 1024;
  const TAIL_BYTES = 64 * 1024;
  const headerBuf = Buffer.alloc(Math.min(HEADER_BYTES, stat.size));
  const headerLen = fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
  const tailBuf = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
  const tailLen = stat.size > tailBuf.length
    ? fs.readSync(fd, tailBuf, 0, tailBuf.length, stat.size - tailBuf.length)
    : headerLen; // small file — tail overlaps header, ignore

  // For T-code scan: stream through file in 1MB chunks, find max T index used
  const tUsedSet = new Set<number>();
  const scanBuf = Buffer.alloc(1024 * 1024);
  let leftover = '';
  let pos = 0;
  while (true) {
    const n = fs.readSync(fd, scanBuf, 0, scanBuf.length, pos);
    if (n === 0) break;
    const chunk = leftover + scanBuf.toString('utf8', 0, n);
    // Match tool changes at start of line: T0..T15 only.
    // Bambu uses T1000/T255 as slot load/unload macros — excluded by the 0-15 cap.
    const matches = chunk.matchAll(/(?:^|\n)T(\d{1,2})\b/g);
    for (const m of matches) {
      const idx = parseInt(m[1], 10);
      if (idx >= 0 && idx < 16) tUsedSet.add(idx);
    }
    // Keep tail to avoid split-miss
    leftover = chunk.slice(-4);
    pos += n;
    if (n < scanBuf.length) break;
  }
  fs.closeSync(fd);

  const headerStr = headerBuf.toString('utf8', 0, headerLen);
  const tailStr = tailBuf.toString('utf8', 0, tailLen);
  // Tail-only fields: filament used [g] / filament cost (slicery summary stats
  // live at end of file). Combine for parsers that may match in either.
  const combinedStr = headerStr + '\n' + tailStr;

  // Accept both `:` and ` = ` separators. Value may be scalar, JSON array,
  // or bracketed bareword list.
  const types = parseValueList(headerStr, /; ?filament_type\s*[:=]\s*(.+)/);
  const colors = parseValueList(headerStr, /; ?filament_colour\s*[:=]\s*(.+)/);
  const weights = parseValueList(combinedStr, /; ?filament used \[g\]\s*[:=]\s*(.+)/)
    ?.map(s => {
      const n = parseFloat(s.replace(/[^0-9.]/g, ''));
      return isNaN(n) ? null : n;
    }) ?? null;

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

/**
 * Extract a list of values from a header line. Tries JSON array, then
 * bracketed list, then comma-split, then scalar (single-element array).
 * Returns null if no match.
 */
function parseValueList(src: string, re: RegExp): string[] | null {
  const m = src.match(re);
  if (!m) return null;
  const raw = m[1].trim();

  // JSON array form: ["PLA","PETG"]
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(String);
  } catch { /* not JSON */ }

  // Bracketed list form: [PLA, PETG]
  const inner = raw.match(/^\[([^\]]+)\]$/);
  if (inner) {
    return inner[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
  }

  // Scalar / comma-separated form: PLA  or  PLA,PETG  or  #FFFFFF
  if (raw.includes(',')) {
    return raw.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
  }
  return [raw.replace(/^["']|["']$/g, '')];
}
