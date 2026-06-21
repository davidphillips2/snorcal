import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getSlicerBinary } from '@snorcal/shared';
import type { SlicerEngine } from '@snorcal/shared';

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
  private sidecarJobId: string | null = null;
  private sidecarUrl: string | null = null;
  private cancelled = false;

  async execute(cmd: SliceCommand, onProgress?: ProgressCallback): Promise<SliceResult> {
    const url = getSidecarUrl(cmd.engine);
    if (url) return this.executeHttp(cmd, url, onProgress);
    return this.executeLocal(cmd, onProgress);
  }

  /**
   * Drive a bambuddy-compatible /slice-async sidecar.
   *
   * Protocol (from github.com/AFKFelix/orca-slicer-api, used by maziggy/bambuddy):
   *   POST  /slice-async        multipart: file + form fields → 202 {requestId}
   *   GET   /slice-async/:id    → {status: pending|processing|completed|failed, metadata?, downloadUrl?}
   *   GET   /slice-async/:id/result  → binary gcode (or zip of gcodes)
   *   DELETE /slice-async/:id   → free sidecar memory
   *
   * Snorcal sends only the embedded 3MF as `file` — no printer/preset/filament
   * profile uploads. The 3MF already contains Metadata/project_settings.config
   * which the slicer reads natively, so no --load-settings is needed.
   */
  private async executeHttp(cmd: SliceCommand, baseUrl: string, onProgress?: ProgressCallback): Promise<SliceResult> {
    this.sidecarUrl = baseUrl;

    if (!fs.existsSync(cmd.input3mf)) {
      return { gcodePath: '', gcodeSize: 0, exitCode: 1, stdout: '', stderr: `Input 3MF missing: ${cmd.input3mf}` };
    }

    const fileBytes = await fs.promises.readFile(cmd.input3mf);
    const filename = path.basename(cmd.input3mf);

    const form = new FormData();
    form.append('file', new Blob([fileBytes]), filename);
    form.append('arrange', '0');
    form.append('orient', '0');
    form.append('exportType', 'gcode');
    if (cmd.plateIndex !== undefined) {
      form.append('plate', String(cmd.plateIndex));
    }

    onProgress?.(2, 'Submitting to sidecar…');

    // Submit
    const submitRes = await fetch(`${baseUrl}/slice-async`, { method: 'POST', body: form });
    if (!resOk(submitRes)) {
      const errText = await safeText(submitRes);
      return { gcodePath: '', gcodeSize: 0, exitCode: 1, stdout: '', stderr: `Sidecar submit failed: HTTP ${submitRes.status} ${errText}` };
    }
    const submitJson = await submitRes.json() as { requestId?: string };
    if (!submitJson.requestId) {
      return { gcodePath: '', gcodeSize: 0, exitCode: 1, stdout: '', stderr: 'Sidecar returned no requestId' };
    }
    this.sidecarJobId = submitJson.requestId;

    // Poll
    onProgress?.(5, 'Queued');
    let metadata: { printTime?: number; filamentUsedG?: number; filamentUsedMm?: number } | undefined;
    let pollErr: string | null = null;
    while (!this.cancelled) {
      await sleep(1500);
      if (this.cancelled) break;
      const statusRes = await fetch(`${baseUrl}/slice-async/${this.sidecarJobId}`);
      if (!resOk(statusRes)) {
        pollErr = `Status poll failed: HTTP ${statusRes.status}`;
        break;
      }
      const statusJson = await statusRes.json() as {
        status: 'pending' | 'processing' | 'completed' | 'failed';
        message?: string;
        metadata?: typeof metadata;
      };
      if (statusJson.status === 'pending') {
        onProgress?.(5, 'Queued');
      } else if (statusJson.status === 'processing') {
        onProgress?.(50, 'Slicing…');
      } else if (statusJson.status === 'failed') {
        pollErr = statusJson.message ?? 'Slicing failed on sidecar';
        break;
      } else if (statusJson.status === 'completed') {
        metadata = statusJson.metadata;
        break;
      }
    }

    if (this.cancelled) {
      // Best-effort cancel on sidecar (no documented cancel endpoint; DELETE
      // is for finished jobs only per bambuddy source — so we just abandon).
      this.sidecarJobId = null;
      return { gcodePath: '', gcodeSize: 0, exitCode: -1, stdout: '', stderr: 'Job cancelled' };
    }
    if (pollErr) {
      return { gcodePath: '', gcodeSize: 0, exitCode: 1, stdout: '', stderr: pollErr };
    }

    // Download result
    onProgress?.(95, 'Downloading gcode…');
    fs.mkdirSync(cmd.outputDir, { recursive: true });
    const resultRes = await fetch(`${baseUrl}/slice-async/${this.sidecarJobId}/result`);
    if (!resOk(resultRes)) {
      const errText = await safeText(resultRes);
      return { gcodePath: '', gcodeSize: 0, exitCode: 1, stdout: '', stderr: `Download failed: HTTP ${resultRes.status} ${errText}` };
    }

    const contentType = resultRes.headers.get('content-type') ?? '';
    let gcodePath: string;
    let gcodeSize: number;

    if (contentType.includes('zip') || filename.endsWith('.zip')) {
      // Multi-plate return — extract first gcode. Snorcal builds single-plate
      // 3MF so this branch shouldn't normally hit; handle defensively.
      const buf = Buffer.from(await resultRes.arrayBuffer());
      gcodePath = await extractFirstGcodeFromZip(buf, cmd.outputDir);
    } else {
      const buf = Buffer.from(await resultRes.arrayBuffer());
      gcodePath = path.join(cmd.outputDir, 'output.gcode');
      await fs.promises.writeFile(gcodePath, buf);
    }
    gcodeSize = fs.statSync(gcodePath).size;

    // Best-effort cleanup
    fetch(`${baseUrl}/slice-async/${this.sidecarJobId}`, { method: 'DELETE' }).catch(() => {});
    this.sidecarJobId = null;

    onProgress?.(100, 'Done');
    const metaLine = metadata ? `\n; sidecar metadata: printTime=${metadata.printTime ?? '?'}s filamentG=${metadata.filamentUsedG ?? '?'} filamentMm=${metadata.filamentUsedMm ?? '?'}` : '';
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
    // HTTP/sidecar mode: set cancelled flag so the poll loop exits. Bambuddy's
    // DELETE /slice-async/:id only works on finished jobs (per source), so
    // running slices keep running on the sidecar until they finish — we just
    // abandon them and ignore the result.
    if (this.sidecarJobId || this.sidecarUrl) {
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

    if (cmd.engine === 'bambustudio') {
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
    if (!fs.existsSync(outputDir)) return null;

    const files = fs.readdirSync(outputDir);
    for (const file of files) {
      const fullPath = path.join(outputDir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && file.endsWith('.gcode')) {
        return { path: fullPath, size: stat.size };
      }
      if (stat.isDirectory()) {
        const result = this.findGcode(fullPath);
        if (result) return result;
      }
    }
    return null;
  }
}

// --- sidecar HTTP helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

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
