import fs from 'node:fs';
import path from 'node:path';

/**
 * Recursively find first `.gcode` file under `dir`. Returns path + byte size,
 * or null if none. Used by slice route + sidecar executor (both walk the
 * slicer output dir which may nest plate-specific subdirs).
 */
export function findGcodeFile(dir: string): { path: string; size: number } | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = fs.statSync(full);
    if (st.isFile() && entry.endsWith('.gcode')) {
      return { path: full, size: st.size };
    }
    if (st.isDirectory()) {
      const sub = findGcodeFile(full);
      if (sub) return sub;
    }
  }
  return null;
}
