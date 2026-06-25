import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import type { PrintOptions } from '@snorcal/shared';

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

/**
 * Klipper/Snapmaker: prepend `M1002 judge_flag <name>` lines so the printer's
 * touchscreen shows the matching prompt at print start. Snapmaker firmware
 * dedupes prompts when the same flag appears twice (e.g. user's slicer
 * already wrote one), so naive prepend is safe.
 *
 * Writes a sibling file `<base>.snorcal.gcode` when injection is needed;
 * returns the input path unchanged when no flags are active so callers can
 * always use the returned path for upload.
 */
export function prepareKlipperGcode(localPath: string, opts?: PrintOptions): string {
  if (!opts) return localPath;
  const lines: string[] = [];
  if (opts.bedLeveling) lines.push('M1002 judge_flag g29_before_print_flag');
  if (opts.timelapse) lines.push('M1002 judge_flag timelapse_record_flag');
  if (lines.length === 0) return localPath;

  const prefix = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const orig = fs.readFileSync(localPath);
  const modifiedPath = localPath.replace(/\.gcode$/i, '.snorcal.gcode');
  fs.writeFileSync(modifiedPath, Buffer.concat([prefix, orig]));
  return modifiedPath;
}
