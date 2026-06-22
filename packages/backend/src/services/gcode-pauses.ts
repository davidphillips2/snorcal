import fs from 'node:fs';
import path from 'node:path';

/**
 * Inject manual pause markers at layer boundaries in a sliced gcode file.
 *
 * Use case: more colors in the slice than physical slots on the printer
 * (Bambu AMS = 4, Snapmaker U1 = 4 direct-drive). User marks a layer as a
 * "pause point" in the UI; the printer stops at that layer, the operator
 * manually swaps a spool, then resumes.
 *
 * Layer indexing matches OrcaSlicer/BambuStudio output:
 *   - First physical layer = layer 0 (printed before any ;LAYER_CHANGE)
 *   - Each `;LAYER_CHANGE` marker transitions to the next layer
 *   - Pause at layer N → injected *before* the Nth `;LAYER_CHANGE` line
 *
 * Pause gcode per printer protocol:
 *   - moonraker/klipper:  `M117 <label>` (LCD msg) + `PAUSE` macro
 *   - bambu / snapmaker:  `M0 ;<label>` (firmware pause, LCD resume button)
 *
 * Output written to `<outputDir>/<basename>.paused.gcode` so original is
 * never modified. Caller serves the paused file when present.
 */

export interface PausePoint {
  layer: number;     // 0-based layer index
  label?: string;    // optional operator hint, e.g. "swap red→yellow"
}

export interface InjectOptions {
  protocol: 'moonraker' | 'bambu';
}

const LAYER_CHANGE_RE = /^;LAYER_CHANGE\b/;

/**
 * Returns pause gcode block for the given protocol + label.
 * Multi-line, newline-terminated, ready to splice into gcode.
 */
function pauseBlock(label: string | undefined, protocol: InjectOptions['protocol']): string {
  const hint = label && label.trim() ? label.trim() : 'manual swap';
  if (protocol === 'moonraker') {
    return `; --- snorcal pause: ${hint} ---
M117 PAUSE: ${hint}
PAUSE
; --- end snorcal pause ---
`;
  }
  // Bambu Lab + Snapmaker both honor M0 as LCD-shown pause w/ resume button
  return `; --- snorcal pause: ${hint} ---
M0 ;${hint}
; --- end snorcal pause ---
`;
}

/**
 * Inject pauses into gcode. Returns path to the paused file (or original
 * path if pauses list is empty/no-op).
 */
export async function injectPauses(
  srcPath: string,
  pauses: PausePoint[],
  options: InjectOptions,
): Promise<string> {
  if (!fs.existsSync(srcPath)) throw new Error(`Source gcode not found: ${srcPath}`);
  if (pauses.length === 0) return srcPath;

  // Sort pauses by layer descending so we can pop from the end as we walk.
  // Layers we still need to inject BEFORE the next ;LAYER_CHANGE.
  // After we emit a ;LAYER_CHANGE for layer N, any pauses with layer===N
  // were already due — but our convention is "before the LAYER_CHANGE that
  // STARTS layer N", so we inject before that specific marker.
  //
  // Implementation: walk lines, track current layer index (-1 = pre-first).
  // When we see ;LAYER_CHANGE, we know the NEXT layer is currentLayer+1.
  // Before emitting the marker, check if any pauses target currentLayer+1.
  const sorted = [...pauses].sort((a, b) => a.layer - b.layer);
  const pausesByLayer = new Map<number, PausePoint[]>();
  for (const p of sorted) {
    const arr = pausesByLayer.get(p.layer) ?? [];
    arr.push(p);
    pausesByLayer.set(p.layer, arr);
  }

  const outPath = path.join(
    path.dirname(srcPath),
    path.basename(srcPath, path.extname(srcPath)) + '.paused' + path.extname(srcPath),
  );

  const input = fs.createReadStream(srcPath, { encoding: 'utf8' });
  const output = fs.createWriteStream(outPath);

  return new Promise<string>((resolve, reject) => {
    let leftover = '';
    let currentLayer = -1; // -1 = before first LAYER_CHANGE; first marker → layer 0
    let done = false;

    // We treat the first ;LAYER_CHANGE as the start of layer 0 (matches
    // UI where slider min=0). If a user pause targets layer 0, inject
    // before that very first marker.

    input.on('data', (chunk: Buffer | string) => {
      const text = leftover + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      const lines = text.split('\n');
      leftover = lines.pop() ?? '';

      const out: string[] = [];
      for (const line of lines) {
        if (LAYER_CHANGE_RE.test(line)) {
          const nextLayer = currentLayer + 1;
          const due = pausesByLayer.get(nextLayer);
          if (due && due.length > 0) {
            for (const p of due) {
              out.push(pauseBlock(p.label, options.protocol));
            }
            pausesByLayer.delete(nextLayer);
          }
          currentLayer = nextLayer;
        }
        out.push(line);
      }
      output.write(out.join('\n') + '\n');
    });

    input.on('end', () => {
      if (leftover) {
        // No LAYER_CHANGE in leftover, just flush
        output.write(leftover + '\n');
      }
      // Warn about un-injected pauses (target layer out of range)
      const missed = [...pausesByLayer.values()].flat();
      if (missed.length > 0) {
        // Log to console — don't fail, file is still usable
        console.warn(`[gcode-pauses] ${missed.length} pause(s) skipped — layer out of range:`,
          missed.map(m => `L${m.layer}`).join(', '));
      }
      done = true;
      output.end(() => resolve(outPath));
    });

    input.on('error', (err) => {
      if (!done) {
        try { fs.unlinkSync(outPath); } catch {}
        reject(err);
      }
    });

    output.on('error', (err) => {
      if (!done) {
        try { fs.unlinkSync(outPath); } catch {}
        reject(err);
      }
    });
  });
}

/**
 * Path to the paused variant of a gcode file, or null if not generated.
 */
export function pausedGcodePath(srcPath: string): string {
  return path.join(
    path.dirname(srcPath),
    path.basename(srcPath, path.extname(srcPath)) + '.paused' + path.extname(srcPath),
  );
}
