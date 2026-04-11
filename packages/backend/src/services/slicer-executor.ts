import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { getSlicerBinary } from '@slorca/shared';
import type { SlicerEngine } from '@slorca/shared';

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
  stderr: string;
}

export type ProgressCallback = (progress: number, step: string) => void;

const isLinux = process.platform === 'linux';

export class SlicerExecutor {
  private child: ChildProcess | null = null;

  async execute(cmd: SliceCommand, onProgress?: ProgressCallback): Promise<SliceResult> {
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
        stderr: `Slicer binary not found at: ${binaryPath}\nSet the environment variable SLICER_PATH_${cmd.engine.toUpperCase()} to the correct path, or run in Docker.`,
      };
    }

    return new Promise((resolve, reject) => {
      let stderr = '';
      let killed = false;

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

      this.child = spawn(spawnCmd, finalArgs, {
        cwd: cmd.workDir,
        env: {
          ...process.env,
          HOME: cmd.workDir,
          DISPLAY: process.env.DISPLAY || (isLinux ? ':99' : undefined),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.child.stdout?.on('data', (data: Buffer) => {
        this.parseProgress(data.toString(), onProgress);
      });

      this.child.stderr?.on('data', (data: Buffer) => {
        const line = data.toString();
        stderr += line;
        this.parseProgress(line, onProgress);
      });

      this.child.on('error', (err) => {
        if (!killed) {
          reject(new Error(`Failed to spawn slicer: ${err.message}`));
        }
      });

      this.child.on('close', (exitCode) => {
        this.child = null;

        if (killed) {
          resolve({ gcodePath: '', gcodeSize: 0, exitCode: -1, stderr: 'Job cancelled' });
          return;
        }

        const gcodeResult = this.findGcode(cmd.outputDir);

        if (exitCode !== 0) {
          resolve({
            gcodePath: gcodeResult?.path ?? '',
            gcodeSize: gcodeResult?.size ?? 0,
            exitCode: exitCode ?? 1,
            stderr,
          });
          return;
        }

        if (!gcodeResult) {
          resolve({ gcodePath: '', gcodeSize: 0, exitCode: 1, stderr: stderr + '\nNo gcode output found' });
          return;
        }

        resolve({ gcodePath: gcodeResult.path, gcodeSize: gcodeResult.size, exitCode: 0, stderr });
      });
    });
  }

  cancel() {
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
