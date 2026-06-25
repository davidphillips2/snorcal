import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';

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

/**
 * Extract the gcode stream out of a Bambu-style `.gcode.3mf` archive.
 *
 * `.gcode.3mf` = 3MF zip with one `Metadata/plate_<N>.gcode` per plate.
 * Bambu printers read the wrapper natively; Klipper/Moonraker need the
 * inner gcode pulled out.
 *
 * Picks the requested plate (1-based); falls back to the lowest plate
 * index present when the requested one doesn't exist. Returns the list
 * of all plate indices found so the caller can show a picker.
 */
export async function extractGcodeFrom3mf(
  buffer: Buffer,
  plate: number = 1,
): Promise<{ text: string; entryName: string; plates: number[] }> {
  const zip = await JSZip.loadAsync(buffer);
  const platePaths: Array<{ name: string; idx: number }> = [];
  for (const name of Object.keys(zip.files)) {
    const m = name.match(/^Metadata\/plate_(\d+)\.gcode$/i);
    if (m) platePaths.push({ name, idx: Number(m[1]) });
  }
  if (platePaths.length === 0) {
    throw new Error('No Metadata/plate_*.gcode entries inside .gcode.3mf');
  }
  platePaths.sort((a, b) => a.idx - b.idx);
  const plates = platePaths.map(p => p.idx);
  const target = platePaths.find(p => p.idx === plate) ?? platePaths[0];
  const entry = zip.file(target.name);
  if (!entry) throw new Error(`Plate entry ${target.name} missing in zip`);
  const text = await entry.async('string');
  return { text, entryName: target.name, plates };
}
