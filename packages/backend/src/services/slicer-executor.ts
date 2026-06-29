import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getSlicerBinary, isBambuStudioClass } from '@snorcal/shared';
import type { SlicerEngine } from '@snorcal/shared';
import { findGcodeFile } from './gcode-utils.js';

export interface SliceCommand {
  engine: SlicerEngine;
  input3mf: string;
  outputDir: string;
  processSettings: string;
  machineSettings: string;
  filamentSettings: string[];
  plateIndex?: number;
  workDir: string;
  dataDir?: string;
  /**
   * Optional profile stubs for bambuddy sidecar sync `/slice` endpoint
   * (slice_with_profiles path). Each entry is a JSON string shaped as
   * `{name, inherits: name, from: "system", type}`. Sidecar walks the
   * `inherits` field against its bundled slicer presets and produces the
   * full resolved profile, then passes via `--load-settings` /
   * `--load-filaments`. Mirrors bambuddy `_resolve_standard`
   * (preset_resolver.py:254-277).
   */
  profileStubs?: {
    printer?: string;    // JSON string for machine profile
    preset?: string;     // JSON string for process profile
    filaments?: string[]; // JSON string per filament slot (1-indexed filenames)
  };
}

export interface SliceResult {
  gcodePath: string;
  gcodeSize: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProgressCallback = (progress: number, step: string) => void;

const isLinux = process.platform === 'linux';

/**
 * Resolve the sidecar URL for an engine.
 *
 * Order: SLICER_URL_<ENGINE> → SLICER_URL (deprecated fallback, applies to both)
 * → null (caller should use local binary path).
 */
export function getSidecarUrl(engine: string): string | null {
  const perEngine = process.env[`SLICER_URL_${engine.toUpperCase()}`];
  if (perEngine) return perEngine.replace(/\/+$/, '');
  const legacy = process.env.SLICER_URL;
  if (legacy) {
    if (!process.env.SLICER_URL_DEPRECATION_WARNED) {
      console.warn('[slicer-executor] SLICER_URL is deprecated — set SLICER_URL_ORCASLICER and SLICER_URL_BAMBU per engine.');
      process.env.SLICER_URL_DEPRECATION_WARNED = '1';
    }
    return legacy.replace(/\/+$/, '');
  }
  return null;
}

export class SlicerExecutor {
  private child: ChildProcess | null = null;
  private sidecarUrl: string | null = null;
  private cancelled = false;

  async execute(cmd: SliceCommand, onProgress?: ProgressCallback): Promise<SliceResult> {
    const url = getSidecarUrl(cmd.engine);
    if (url) return this.executeHttp(cmd, url, onProgress);
    return this.executeLocal(cmd, onProgress);
  }

  /**
   * Drive a bambuddy-compatible sync /slice sidecar.
   *
   * When `cmd.profileStubs` is provided, mirrors `slice_with_profiles` in
   * bambuddy/backend/app/services/slicer_api.py: multipart POST with the
   * 3MF as `file` + `printerProfile` + `presetProfile` + N `filamentProfile`
   * parts. Sidecar runs `--load-settings printer.json --load-filaments
   * filament_1.json;... --slice N input.3mf`. Bundled slicer presets fill
   * in printer/extruder baseline; embedded 3MF provides geometry + plate +
   * paint_color overrides.
   *
   * Without profileStubs, falls back to `slice_without_profiles` path
   * (file-only upload, embedded settings only).
   */
  private async executeHttp(cmd: SliceCommand, baseUrl: string, onProgress?: ProgressCallback): Promise<SliceResult> {
    this.sidecarUrl = baseUrl;

    if (!fs.existsSync(cmd.input3mf)) {
      return { gcodePath: '', gcodeSize: 0, exitCode: 1, stdout: '', stderr: `Input 3MF missing: ${cmd.input3mf}` };
    }

    const fileBytes = await fs.promises.readFile(cmd.input3mf);
    const filename = path.basename(cmd.input3mf);
    // Sidecar validates MIME type against an allowlist (model/3mf, model/stl,
    // model/step). Default Blob has empty type → rejected with HTTP 400.
    const ext = path.extname(filename).toLowerCase();
    const mime =
      ext === '.3mf' ? 'model/3mf' :
      ext === '.stl' ? 'model/stl' :
      ext === '.step' || ext === '.stp' ? 'model/step' :
      'application/octet-stream';

    const plate = cmd.plateIndex !== undefined
      ? (cmd.plateIndex > 0 ? cmd.plateIndex : 1)
      : 1;

    // Sync /slice — mirrors bambuddy's slice_without_profiles path exactly.
    // Single POST, connection held until slicer exits, body is gcode (or zip
    // for multi-plate). Async /slice-async was the previous path; switched
    // to sync to match bambuddy's working flow 1:1 (see slicer-api Python
    // client `slice_without_profiles` in bambuddy/backend/app/services/).
    console.log(`[SlicerExecutor] sidecar POST ${baseUrl}/slice file=${filename} (${fileBytes.length} bytes) plate=${plate}`);

    const form = new FormData();
    form.append('file', new Blob([fileBytes], { type: mime }), filename);
    form.append('arrange', '0');
    form.append('orient', '0');
    form.append('exportType', 'gcode');
    form.append('plate', String(plate));

    // Profile stub uploads (bambuddy slice_with_profiles path). Each value
    // is a JSON string shaped {name, inherits, from: "system", type}. Sidecar
    // walks inherits against bundled slicer presets → full resolved profile
    // → --load-settings / --load-filaments. Field names mirror bambuddy
    // exactly (slicer_api.py:242-253) so the same /slice route accepts both.
    if (cmd.profileStubs?.printer) {
      form.append('printerProfile', new Blob([cmd.profileStubs.printer], { type: 'application/json' }), 'printer.json');
    }
    if (cmd.profileStubs?.preset) {
      form.append('presetProfile', new Blob([cmd.profileStubs.preset], { type: 'application/json' }), 'preset.json');
    }
    if (cmd.profileStubs?.filaments && cmd.profileStubs.filaments.length > 0) {
      cmd.profileStubs.filaments.forEach((json, i) => {
        form.append('filamentProfile', new Blob([json], { type: 'application/json' }), `filament_${i + 1}.json`);
      });
    }

    onProgress?.(2, 'Submitting to sidecar…');

    const sliceRes = await fetch(`${baseUrl}/slice`, { method: 'POST', body: form });
    if (!resOk(sliceRes)) {
      const errText = await safeText(sliceRes);
      return { gcodePath: '', gcodeSize: 0, exitCode: 1, stdout: '', stderr: `Sidecar sync slice failed: HTTP ${sliceRes.status} ${errText}` };
    }
    onProgress?.(95, 'Downloading gcode…');
    fs.mkdirSync(cmd.outputDir, { recursive: true });
    const contentType = sliceRes.headers.get('content-type') ?? '';
    const buf = Buffer.from(await sliceRes.arrayBuffer());
    let gcodePath: string;
    if (contentType.includes('zip')) {
      gcodePath = await extractFirstGcodeFromZip(buf, cmd.outputDir);
    } else {
      gcodePath = path.join(cmd.outputDir, 'output.gcode');
      await fs.promises.writeFile(gcodePath, buf);
    }
    const gcodeSize = fs.statSync(gcodePath).size;
    onProgress?.(100, 'Done');

    // Best-effort metadata from response headers (bambuddy sidecar emits
    // X-Print-Time-Seconds / X-Filament-Used-G / X-Filament-Used-Mm).
    const printTime = sliceRes.headers.get('x-print-time-seconds');
    const filamentG = sliceRes.headers.get('x-filament-used-g');
    const metaLine = (printTime || filamentG)
      ? `\n; sidecar metadata: printTime=${printTime ?? '?'}s filamentG=${filamentG ?? '?'}`
      : '';

    return {
      gcodePath,
      gcodeSize,
      exitCode: 0,
      stdout: metaLine,
      stderr: '',
    };
  }

  private cancelHttp: (() => void) | null = null;

  private async executeLocal(cmd: SliceCommand, onProgress?: ProgressCallback): Promise<SliceResult> {
    const binary = getSlicerBinary(cmd.engine);

    fs.mkdirSync(cmd.outputDir, { recursive: true });

    const args = this.buildArgs(cmd);
    const binaryPath = binary.binaryPath;

    console.log(`[SlicerExecutor] Executing: ${binaryPath} ${args.join(' ')}`);

    // Check if binary exists
    if (!fs.existsSync(binaryPath)) {
      return {
        gcodePath: '',
        gcodeSize: 0,
        exitCode: 127,
        stdout: '',
        stderr: `Slicer binary not found at: ${binaryPath}\nSet the environment variable SLICER_PATH_${cmd.engine.toUpperCase()} to the correct path, or run in Docker.`,
      };
    }

    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let killed = false;
      let sawOutput = false;
      let sawGcodeFile = false;

      // Build spawn options
      const spawnArgs = isLinux && !process.env.DISPLAY
        ? ['xvfb-run', '--auto-servernum', '--server-args=-screen 0 1024x768x24', binaryPath, ...args]
        : args;

      const spawnCmd = isLinux && !process.env.DISPLAY
        ? 'xvfb-run'
        : binaryPath;

      const finalArgs = isLinux && !process.env.DISPLAY
        ? ['--auto-servernum', '--server-args=-screen 0 1024x768x24', binaryPath, ...args]
        : args;

      onProgress?.(5, 'Spawning slicer...');

      this.child = spawn(spawnCmd, finalArgs, {
        cwd: cmd.workDir,
        env: {
          ...process.env,
          DISPLAY: process.env.DISPLAY || (isLinux ? ':99' : undefined),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // OrcaSlicer CLI emits no parseable progress markers. Poll the output
      // dir for the gcode file as the only reliable phase signal — when it
      // appears, slicer has finished computing and is streaming gcode out.
      const gcodePoll = setInterval(() => {
        if (sawGcodeFile || killed) return;
        try {
          const files = fs.readdirSync(cmd.outputDir);
          if (files.some(f => f.endsWith('.gcode'))) {
            sawGcodeFile = true;
            onProgress?.(90, 'Writing gcode...');
          }
        } catch { /* dir may briefly not exist */ }
      }, 1000);

      this.child.stdout?.on('data', (data: Buffer) => {
        const str = data.toString();
        stdout += str;
        if (!sawOutput) {
          sawOutput = true;
          if (!sawGcodeFile) onProgress?.(20, 'Slicing...');
        }
        this.parseProgress(str, onProgress);
      });

      this.child.stderr?.on('data', (data: Buffer) => {
        const line = data.toString();
        stderr += line;
        if (!sawOutput) {
          sawOutput = true;
          if (!sawGcodeFile) onProgress?.(20, 'Slicing...');
        }
        this.parseProgress(line, onProgress);
      });

      this.child.on('error', (err) => {
        clearInterval(gcodePoll);
        if (!killed) {
          reject(new Error(`Failed to spawn slicer: ${err.message}`));
        }
      });

      this.child.on('close', (exitCode) => {
        clearInterval(gcodePoll);
        this.child = null;

        if (killed) {
          resolve({ gcodePath: '', gcodeSize: 0, exitCode: -1, stdout, stderr: 'Job cancelled' });
          return;
        }

        const gcodeResult = this.findGcode(cmd.outputDir);

        if (exitCode !== 0) {
          resolve({
            gcodePath: gcodeResult?.path ?? '',
            gcodeSize: gcodeResult?.size ?? 0,
            exitCode: exitCode ?? 1,
            stdout,
            stderr,
          });
          return;
        }

        if (!gcodeResult) {
          resolve({ gcodePath: '', gcodeSize: 0, exitCode: 1, stdout, stderr: stderr + '\nNo gcode output found' });
          return;
        }

        resolve({ gcodePath: gcodeResult.path, gcodeSize: gcodeResult.size, exitCode: 0, stdout, stderr });
      });
    });
  }

  cancel() {
    // HTTP/sidecar mode: sync fetch has no abort signal wired here — set the
    // flag so any later code can detect cancellation, but the in-flight slice
    // keeps running on the sidecar until it finishes. We just abandon it.
    if (this.sidecarUrl) {
      this.cancelled = true;
      return;
    }
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
      setTimeout(() => {
        if (this.child && !this.child.killed) this.child.kill('SIGKILL');
      }, 5000);
    }
  }

  private buildArgs(cmd: SliceCommand): string[] {
    const args: string[] = [];

    // Point to slicer's data dir (contains system profiles cache)
    if (cmd.dataDir) {
      args.push('--datadir', cmd.dataDir);
    }

    args.push(
      '--slice', String(cmd.plateIndex ?? 0),
      '--outputdir', cmd.outputDir,
      '--arrange', '0',
      '--orient', '0',
      '--debug', '2',
    );

    if (isBambuStudioClass(cmd.engine)) {
      args.push('--skip_useless_pick');
    }

    args.push(cmd.input3mf);
    return args;
  }

  private parseProgress(output: string, onProgress?: ProgressCallback) {
    if (!onProgress) return;

    const percentMatch = output.match(/(\d+)%/);
    if (percentMatch) {
      onProgress(parseInt(percentMatch[1], 10), '');
    }

    if (output.includes('Slicing input')) {
      onProgress(10, 'Starting slice...');
    } else if (output.includes('Generating G-code')) {
      onProgress(80, 'Generating G-code...');
    } else if (output.includes('Exporting')) {
      onProgress(95, 'Exporting output...');
    }
  }

  private findGcode(outputDir: string): { path: string; size: number } | null {
    const found = findGcodeFile(outputDir);
    if (!found) return null;
    return { path: found, size: fs.statSync(found).size };
  }
}

// --- sidecar HTTP helpers ---

function resOk(res: Response): boolean {
  return res.status >= 200 && res.status < 300;
}

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 500); }
  catch { return ''; }
}

/**
 * Snorcal builds single-plate 3MF, so bambuddy should always return a single
 * gcode. If we ever receive a zip (defensive path), extract the first .gcode.
 */
async function extractFirstGcodeFromZip(buf: Buffer, outDir: string): Promise<string> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  for (const name of Object.keys(zip.files)) {
    if (name.endsWith('.gcode')) {
      const content = await zip.files[name].async('nodebuffer');
      const outPath = path.join(outDir, path.basename(name));
      await fs.promises.writeFile(outPath, content);
      return outPath;
    }
  }
  throw new Error('No .gcode inside result zip');
}
