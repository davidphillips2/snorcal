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

/**
 * Wrap raw gcode into a Bambu-style `.gcode.3mf` ZIP container.
 *
 * OrcaSlicer/BambuStudio CLI only outputs raw `.gcode` — the `.gcode.3mf`
 * format (a 3MF zip with the gcode at `Metadata/plate_<N>.gcode` plus
 * minimal 3MF metadata) is a GUI-only "Export plate sliced file" action.
 * Bambu printers and bambuddy's archive upload require the 3MF container,
 * so we synthesize one from the raw gcode here.
 *
 * The wrapper parses the gcode header block (`; HEADER_BLOCK_START..END`)
 * for `total layer number`, `max_z_height`, filament info, etc. and writes
 * a proper XML `slice_info.config` matching OrcaSlicer's format. The P1S
 * firmware reads layer count from `slice_info.config`, NOT from gcode
 * comments — so without this the printer reports `total_layer_num: 0`.
 */
function parseGcodeHeader(gcode: string): Record<string, string> {
  const header: Record<string, string> = {};
  const lines = gcode.split('\n');
  let inHeader = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '; HEADER_BLOCK_START') { inHeader = true; continue; }
    if (line === '; HEADER_BLOCK_END') break;
    if (!inHeader) continue;
    const m = line.match(/^;\s*([^:]+?)\s*:\s*(.+?)\s*$/);
    if (m) {
      // Normalise: lowercase, underscores for spaces
      header[m[1].toLowerCase().replace(/\s+/g, '_')] = m[2];
    }
  }
  return header;
}

export async function wrapGcodeAs3mf(
  gcodePath: string,
  plateNum: number = 1,
): Promise<{ buffer: Buffer; filename: string }> {
  const gcode = fs.readFileSync(gcodePath, 'utf-8');
  const baseName = path.basename(gcodePath).replace(/\.gcode$/i, '');
  const hdr = parseGcodeHeader(gcode);

  const totalLayers = hdr.total_layer_number ? parseInt(hdr.total_layer_number, 10) : 0;
  const maxZ = hdr.max_z_height ? parseFloat(hdr.max_z_height) : 0;
  const prediction = hdr.estimated_printing_time || '';
  const weight = hdr.total_filament_weight ? parseFloat(hdr.total_filament_weight) : 0;

  // Parse filaments from header: ; filament_diameter: 1.75,1.75
  // ; filament_type: PLA,PETG ; filament_density: 1.26,1.26
  const fTypes = (hdr.filament_type || '').split(',');
  const fColors = (hdr.filament_colour || hdr.filament_color || '').split(',');

  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
    + '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
    + '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n'
    + '  <Default Extension="gcode" ContentType="application/vnd.bambu.gcode"/>\n'
    + '  <Override PartName="/Metadata/slice_info.config" ContentType="application/vnd.bambu.slice_info+xml"/>\n'
    + '  <Override PartName="/Metadata/plate_' + plateNum + '.gcode" ContentType="application/vnd.bambu.gcode"/>\n'
    + '</Types>\n');

  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
    + '  <Relationship Target="/Metadata/slice_info.config" Id="rel0" Type="http://schemas.bambu.com/package/2022/sliceinfo"/>\n'
    + '</Relationships>\n');

  // Build XML slice_info.config matching OrcaSlicer's format. The P1S reads
  // layer count, print time, and filament info from here — without it the
  // printer reports total_layer_num=0 and layer_num=0 over MQTT.
  let si = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n';
  si += '  <header>\n';
  si += '    <header_item key="X-BBL-Client-Type" value="slicer"/>\n';
  si += '    <header_item key="X-BBL-Client-Version" value="snorcal"/>\n';
  si += '  </header>\n';
  si += `  <plate>\n`;
  si += `    <metadata key="index" value="${plateNum}"/>\n`;
  si += `    <metadata key="prediction" value="${prediction}"/>\n`;
  if (weight > 0) si += `    <metadata key="weight" value="${weight}"/>\n`;
  // Filament entries
  const fCount = fTypes.length > 0 && fTypes[0] ? fTypes.length : 0;
  for (let i = 0; i < fCount; i++) {
    const t = fTypes[i] || 'PLA';
    const c = (fColors[i] || '#FFFFFFFF').replace(/^#/, '').padEnd(8, 'F');
    si += `    <filament id="${i + 1}" type="${t}" color="#${c}"/>\n`;
  }
  // layer_filament_lists — the P1S computes total_layer_num from the max
  // value in layer_ranges. Without this the printer reports layer 0/0.
  // Single-filament print: one range covering all layers, filament_list="0".
  if (totalLayers > 0) {
    si += `    <layer_filament_lists>\n`;
    si += `      <layer_filament_list filament_list="0" layer_ranges="0 ${totalLayers - 1}"/>\n`;
    si += `    </layer_filament_lists>\n`;
  }
  si += `  </plate>\n`;
  si += `</config>\n`;

  zip.file('Metadata/slice_info.config', si);
  zip.file(`Metadata/plate_${plateNum}.gcode`, gcode);

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return { buffer, filename: `${baseName}.gcode.3mf` };
}
