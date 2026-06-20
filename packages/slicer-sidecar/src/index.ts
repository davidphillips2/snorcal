import Fastify from 'fastify';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getSlicerBinary } from '@snorcal/shared';
import type { SlicerEngine } from '@snorcal/shared';

interface SliceRequest {
  id: string;
  engine: SlicerEngine;
  input3mf: string;
  outputDir: string;
  plateIndex?: number;
  workDir: string;
  dataDir?: string;
}

interface RunningJob {
  child: ChildProcess;
  cancelled: boolean;
}

const running = new Map<string, RunningJob>();

const isLinux = process.platform === 'linux';

function buildArgs(cmd: SliceRequest): string[] {
  const args: string[] = [];
  if (cmd.dataDir) args.push('--datadir', cmd.dataDir);
  args.push(
    '--slice', String(cmd.plateIndex ?? 0),
    '--outputdir', cmd.outputDir,
    '--arrange', '0',
    '--orient', '0',
    '--debug', '2',
  );
  if (cmd.engine === 'bambustudio') args.push('--skip_useless_pick');
  args.push(cmd.input3mf);
  return args;
}

function findGcode(outputDir: string): { path: string; size: number } | null {
  if (!fs.existsSync(outputDir)) return null;
  for (const file of fs.readdirSync(outputDir)) {
    const fullPath = path.join(outputDir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isFile() && file.endsWith('.gcode')) return { path: fullPath, size: stat.size };
    if (stat.isDirectory()) {
      const r = findGcode(fullPath);
      if (r) return r;
    }
  }
  return null;
}

function parseProgress(out: string): { progress: number; step: string } | null {
  const m = out.match(/(\d+)%/);
  if (m) return { progress: parseInt(m[1], 10), step: '' };
  if (out.includes('Slicing input')) return { progress: 10, step: 'Starting slice...' };
  if (out.includes('Generating G-code')) return { progress: 80, step: 'Generating G-code...' };
  if (out.includes('Exporting')) return { progress: 95, step: 'Exporting output...' };
  return null;
}

async function runSlice(cmd: SliceRequest, send: (event: string, data: unknown) => boolean): Promise<void> {
  const binary = getSlicerBinary(cmd.engine);
  const binaryPath = binary.binaryPath;
  fs.mkdirSync(cmd.outputDir, { recursive: true });

  if (!fs.existsSync(binaryPath)) {
    send('error', { message: `Slicer binary not found at: ${binaryPath}` });
    return;
  }

  const args = buildArgs(cmd);
  console.log(`[sidecar] ${cmd.id}: ${binaryPath} ${args.join(' ')}`);

  const useXvfb = isLinux && !process.env.DISPLAY;
  const spawnCmd = useXvfb ? 'xvfb-run' : binaryPath;
  const finalArgs = useXvfb
    ? ['--auto-servernum', '--server-args=-screen 0 1024x768x24', binaryPath, ...args]
    : args;

  let stdout = '';
  let stderr = '';

  await new Promise<void>((resolve) => {
    const child = spawn(spawnCmd, finalArgs, {
      cwd: cmd.workDir,
      env: { ...process.env, DISPLAY: process.env.DISPLAY || (isLinux ? ':99' : undefined) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    running.set(cmd.id, { child, cancelled: false });

    child.stdout?.on('data', (b: Buffer) => {
      const s = b.toString();
      stdout += s;
      const p = parseProgress(s);
      if (p) send('progress', p);
    });
    child.stderr?.on('data', (b: Buffer) => {
      const s = b.toString();
      stderr += s;
      const p = parseProgress(s);
      if (p) send('progress', p);
    });
    child.on('error', (err) => {
      running.delete(cmd.id);
      send('error', { message: `Spawn failed: ${err.message}` });
      resolve();
    });
    child.on('close', (exitCode) => {
      const job = running.get(cmd.id);
      running.delete(cmd.id);
      if (job?.cancelled) {
        send('done', { exitCode: -1, stdout, stderr: 'Job cancelled', gcodePath: '', gcodeSize: 0 });
        resolve();
        return;
      }
      const gcode = findGcode(cmd.outputDir);
      send('done', {
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
        gcodePath: gcode?.path ?? '',
        gcodeSize: gcode?.size ?? 0,
      });
      resolve();
    });
  });
}

const app = Fastify({ logger: true });

app.get('/health', async () => ({ ok: true, timestamp: new Date().toISOString() }));

app.post('/slice', async (req, reply) => {
  const cmd = req.body as SliceRequest;
  if (!cmd?.id || !cmd?.engine || !cmd?.input3mf) {
    return reply.code(400).send({ error: 'Missing id, engine, or input3mf' });
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const send = (event: string, data: unknown): boolean => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  };

  // Keepalive so proxies don't kill idle connection
  const keepalive = setInterval(() => reply.raw.write(': ping\n\n'), 15000);

  req.raw.on('close', () => {
    clearInterval(keepalive);
    const job = running.get(cmd.id);
    if (job && !job.child.killed) {
      job.cancelled = true;
      job.child.kill('SIGTERM');
      setTimeout(() => {
        if (job.child && !job.child.killed) job.child.kill('SIGKILL');
      }, 5000);
    }
  });

  try {
    await runSlice(cmd, send);
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearInterval(keepalive);
    reply.raw.end();
  }
});

app.post('/cancel/:id', async (req) => {
  const { id } = req.params as { id: string };
  const job = running.get(id);
  if (!job) return { ok: false, error: 'Not running' };
  job.cancelled = true;
  if (!job.child.killed) job.child.kill('SIGTERM');
  return { ok: true };
});

const PORT = parseInt(process.env.SLICER_PORT || '3001', 10);
const HOST = process.env.SLICER_HOST || '0.0.0.0';

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`[slicer-sidecar] listening on ${HOST}:${PORT}`);
}).catch((err) => {
  console.error('[slicer-sidecar] failed to start:', err);
  process.exit(1);
});
