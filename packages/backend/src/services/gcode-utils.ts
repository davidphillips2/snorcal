import * as fs from 'fs';
import * as path from 'path';

/**
 * Recursively find the first `.gcode` file under `dir`.
 * Slicers sometimes nest output (image/, subdirs), so recurse.
 * Returns absolute path or null when nothing matches.
 */
export function findGcodeFile(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = fs.statSync(full);
    if (st.isFile() && entry.endsWith('.gcode')) return full;
    if (st.isDirectory()) {
      const sub = findGcodeFile(full);
      if (sub) return sub;
    }
  }
  return null;
}
