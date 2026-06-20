import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Rewrite T-code tool changes in a gcode file per a mapping array.
 * Used for Klipper / Creality CFS / generic multi-extruder printers
 * that have no remote filament-mapping API — the mapping must live
 * inside the gcode itself as T0/T1/T2/T3 tool-change commands.
 *
 * `mapping[i] = j` means gcode filament index i should use physical slot j.
 *
 * Strategy: stream the file line by line. For each `T<n>` tool change at
 * the start of a line (possibly preceded by whitespace), emit `T<mapping[n]>`
 * instead. Pass through all other lines unchanged. Write to a temp file
 * in the same directory (so rename is atomic on the same filesystem).
 *
 * Returns the path to the rewritten file. Caller responsible for cleanup.
 */
export async function rewriteGcodeToolMapping(srcPath: string, mapping: number[]): Promise<string> {
  if (!fs.existsSync(srcPath)) throw new Error(`Source gcode not found: ${srcPath}`);
  if (mapping.length === 0) return srcPath; // nothing to do

  const tmpPath = path.join(
    path.dirname(srcPath),
    '.' + path.basename(srcPath) + '.mapped' + path.extname(srcPath),
  );

  const input = fs.createReadStream(srcPath, { encoding: 'utf8' });
  const output = fs.createWriteStream(tmpPath);

  // T-codes: line starts with T followed by digits, optional comment after whitespace
  const tRe = /^([ \t]*)T(\d+)(\b.*)$/;

  return new Promise<string>((resolve, reject) => {
    let leftover = '';
    let resolved = false;

    input.on('data', (chunk: Buffer | string) => {
      const text = leftover + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      const lines = text.split('\n');
      // Hold back last partial line
      leftover = lines.pop() ?? '';

      const out: string[] = [];
      for (const line of lines) {
        const m = line.match(tRe);
        if (m) {
          const orig = parseInt(m[2], 10);
          // Only remap if orig index is in mapping range and target differs
          if (orig < mapping.length) {
            const target = mapping[orig];
            if (target !== orig && target >= 0) {
              out.push(`${m[1]}T${target}${m[3]}`);
              continue;
            }
          }
        }
        out.push(line);
      }
      output.write(out.join('\n') + '\n');
    });

    input.on('end', () => {
      // Flush remaining leftover
      if (leftover) {
        const m = leftover.match(tRe);
        if (m) {
          const orig = parseInt(m[2], 10);
          if (orig < mapping.length) {
            const target = mapping[orig];
            if (target !== orig && target >= 0) {
              output.write(`${m[1]}T${target}${m[3]}\n`);
              resolved = true;
              output.end(() => resolve(tmpPath));
              return;
            }
          }
        }
        output.write(leftover + '\n');
      }
      resolved = true;
      output.end(() => resolve(tmpPath));
    });

    input.on('error', (err) => {
      if (!resolved) {
        try { fs.unlinkSync(tmpPath); } catch {}
        reject(err);
      }
    });

    output.on('error', (err) => {
      if (!resolved) {
        try { fs.unlinkSync(tmpPath); } catch {}
        reject(err);
      }
    });
  });
}

// Helper for callers that want to know if rewrite would change anything
export function mappingIsNoop(mapping: number[]): boolean {
  return mapping.every((v, i) => v === i);
}

// Discard temp files older than 1 hour in the same dir
export function cleanupOldMappedGcodes(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('.') || !f.includes('.mapped')) continue;
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) fs.unlinkSync(full);
    } catch { /* ignore */ }
  }
}
