import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { discoverDevices } from '../services/ssdp-discovery.js';
import { printerManager } from '../services/printer-manager.js';
import { BambuAdapter } from '../services/adapters/bambu-adapter.js';
import type { PrinterCommand, PrinterProtocol } from '@slorca/shared';

function toPrinterRecord(row: any) {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    ip: row.ip,
    port: row.port,
    serial: row.serial,
    accessCode: row.access_code,
    apiKey: row.api_key,
    cameraStreamUrl: row.camera_stream_url,
    cameraSnapshotUrl: row.camera_snapshot_url,
    model: row.model,
    bedVolume: resolveBedVolume(dbForResolver, row.model),
    lastStatus: row.last_status,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
  };
}

// Resolved lazily — set by printerRoutes() init. Avoids passing db through every call.
let dbForResolver: import('../db/index.js').Db | null = null;

/**
 * Resolve printer bed volume (mm) from its `model` family by looking up any
 * matching machine profile across engines. Returns null if not resolvable.
 * `printable_area` is a 4-point "XxY" polygon; we take max X/Y as bed size.
 */
function resolveBedVolume(db: import('../db/index.js').Db | null, model: string | null | undefined): { x: number; y: number; z: number } | null {
  if (!db || !model) return null;
  const engines = ['orcaslicer', 'bambustudio', 'snapmaker_orca'];
  for (const engine of engines) {
    let rows: { name: string }[];
    try {
      rows = db.listProfiles(engine, 'machine') as any;
    } catch { continue; }
    // First profile whose name is the model exactly OR starts with "model " / "model("
    const match = rows.find(r =>
      r.name === model || r.name.startsWith(model + ' ') || r.name.startsWith(model + '(')
    );
    if (!match) continue;
    const full = db.getProfile(engine, 'machine', match.name) as { settings: string } | undefined;
    if (!full?.settings) continue;
    try {
      const s = JSON.parse(full.settings) as Record<string, unknown>;
      const area = s.printable_area;
      const height = s.printable_height;
      let maxX = 0, maxY = 0;
      if (Array.isArray(area)) {
        for (const pt of area as string[]) {
          const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/i.exec(String(pt));
          if (m) {
            maxX = Math.max(maxX, parseFloat(m[1]));
            maxY = Math.max(maxY, parseFloat(m[2]));
          }
        }
      }
      const z = height ? parseFloat(String(height)) : 0;
      if (maxX > 0 && maxY > 0) return { x: maxX, y: maxY, z: z || 200 };
    } catch { /* ignore malformed */ }
  }
  return null;
}

interface PrinterTestBody {
  printerIp: string;
  printerPort?: number;
}

interface PrinterSendBody {
  jobId: string;
  printerIp: string;
  printerPort?: number;
}

const MOONRAKER_PORT = 7125;

import net from 'node:net';

async function probeTcp(ip: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.connect(port, ip, () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on('error', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
  });
}

async function testPrinterConnection(ip: string, port?: number): Promise<{ ok: boolean; info?: string; error?: string }> {
  // If user specified a port, probe it directly
  if (port) {
    const open = await probeTcp(ip, port);
    if (open) return { ok: true, info: `Port ${port} open on ${ip}` };
    return { ok: false, error: `Port ${port} not reachable on ${ip}` };
  }

  // Auto-detect: try HTTP probes first, then TCP-only for MQTT
  const httpProbes: Array<{ port: number; path: string; type: string }> = [
    { port: 7125, path: '/printer/info', type: 'Moonraker/Klipper' },
    { port: 80, path: '/api/version', type: 'OctoPrint' },
  ];

  for (const attempt of httpProbes) {
    try {
      const res = await fetch(`http://${ip}:${attempt.port}${attempt.path}`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) continue;
      const json = await res.json() as any;

      if (attempt.type === 'Moonraker/Klipper' && json.result) {
        const state = json.result.state || 'unknown';
        const version = json.result.software_version || '';
        return { ok: true, info: `${attempt.type} ${state}${version ? ` (${version})` : ''}` };
      }
      if (attempt.type === 'OctoPrint' && (json.server || json.api)) {
        return { ok: true, info: `${attempt.type} ${json.server || ''}`.trim() };
      }
    } catch {}
  }

  // TCP-only probes for non-HTTP protocols
  const tcpProbes: Array<{ port: number; type: string }> = [
    { port: 7125, type: 'Possible Moonraker/Klipper' },
    { port: 8883, type: 'Possible MQTT/TLS device' },
    { port: 6001, type: 'Possible Bambu Lab HTTP' },
  ];

  for (const attempt of tcpProbes) {
    const open = await probeTcp(ip, attempt.port);
    if (open) return { ok: true, info: `${attempt.type} (port ${attempt.port} open)` };
  }

  return { ok: false, error: 'No printer found on common ports (7125, 8883, 6001, 80)' };
}

export async function printerRoutes(app: FastifyInstance, options: { db: Db }) {
  const { db } = options;
  dbForResolver = db;

  // GET /api/printers/discover — SSDP scan for devices on local network
  app.get('/api/printers/discover', async (req: FastifyRequest, reply: FastifyReply) => {
    const timeout = Math.min(Math.max(parseInt((req.query as any).timeout as string) || 5000, 2000), 15000);
    try {
      const devices = await discoverDevices(timeout);
      return reply.send({ ok: true, data: devices });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.send({ ok: false, error: `Discovery failed: ${message}` });
    }
  });

  // POST /api/printers/test — test connection to printer
  app.post('/api/printers/test', async (req: FastifyRequest, reply: FastifyReply) => {
    const { printerIp, printerPort } = req.body as PrinterTestBody;
    if (!printerIp) return reply.status(400).send({ ok: false, error: 'printerIp required' });
    const result = await testPrinterConnection(printerIp, printerPort);
    if (!result.ok) return reply.send({ ok: false, error: result.error });
    return reply.send({ ok: true, data: { info: result.info } });
  });

  // --- Printer registry CRUD + monitoring ---

  // GET /api/printers — list registered printers + cached status
  app.get('/api/printers', async (_req, reply) => {
    const rows = db.listPrinters();
    const data = rows.map(row => ({
      ...toPrinterRecord(row),
      status: printerManager.getStatus(row.id) ?? null,
    }));
    return reply.send({ ok: true, data });
  });

  // GET /api/printers/:id — single printer + status
  app.get<{ Params: { id: string } }>('/api/printers/:id', async (req, reply) => {
    const row = db.getPrinter(req.params.id);
    if (!row) return reply.status(404).send({ ok: false, error: 'Printer not found' });
    return reply.send({
      ok: true,
      data: { ...toPrinterRecord(row), status: printerManager.getStatus(row.id) ?? null },
    });
  });

  // POST /api/printers — register new printer (triggers adapter connect)
  app.post('/api/printers', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as {
      name: string;
      protocol: PrinterProtocol;
      ip: string;
      port?: number;
      serial?: string;
      accessCode?: string;
      apiKey?: string;
      cameraStreamUrl?: string;
      cameraSnapshotUrl?: string;
      model?: string;
    };
    if (!body.name || !body.protocol || !body.ip) {
      return reply.status(400).send({ ok: false, error: 'name, protocol, ip required' });
    }
    if (body.protocol === 'bambu' && (!body.serial || !body.accessCode)) {
      return reply.status(400).send({ ok: false, error: 'serial and accessCode required for bambu' });
    }
    const id = randomUUID();
    const port = body.port ?? (body.protocol === 'bambu' ? 8883 : 7125);
    db.insertPrinter({
      id, name: body.name, protocol: body.protocol, ip: body.ip, port,
      serial: body.serial, access_code: body.accessCode, api_key: body.apiKey,
      camera_stream_url: body.cameraStreamUrl || null,
      camera_snapshot_url: body.cameraSnapshotUrl || null,
      model: body.model || null,
    });
    const row = db.getPrinter(id)!;
    await printerManager.startAdapter(row).catch(err => {
      console.error(`[printers] failed to connect ${id}:`, err);
    });
    return reply.send({ ok: true, data: toPrinterRecord(row) });
  });

  // DELETE /api/printers/:id
  app.delete<{ Params: { id: string } }>('/api/printers/:id', async (req, reply) => {
    await printerManager.stopAdapter(req.params.id).catch(() => {});
    db.deletePrinter(req.params.id);
    return reply.send({ ok: true });
  });

  // PATCH /api/printers/:id — update mutable fields (currently: model)
  app.patch<{ Params: { id: string } }>('/api/printers/:id', async (req, reply) => {
    const body = req.body as { model?: string };
    const row = db.getPrinter(req.params.id);
    if (!row) return reply.status(404).send({ ok: false, error: 'Printer not found' });
    if (typeof body.model !== 'undefined') {
      db.updatePrinterModel(req.params.id, body.model || null);
    }
    const updated = db.getPrinter(req.params.id)!;
    return reply.send({ ok: true, data: toPrinterRecord(updated) });
  });

  // GET /api/printers/models — unique machine family names across all known engines.
  // Strips nozzle variants ("0.4 nozzle", "(0.6 nozzle)") so each printer model
  // appears once regardless of nozzle options.
  app.get('/api/printers/models', async (_req, reply) => {
    const engines = ['orcaslicer', 'bambustudio', 'snapmaker_orca'];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const engine of engines) {
      try {
        const rows = db.listProfiles(engine, 'machine');
        for (const r of rows) {
          if (!r.name) continue;
          const clean = r.name
            .replace(/\s*\(?\s*0\.\d+\s*(?:mm)?\s*nozzle\s*\)?\s*/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (clean && !seen.has(clean)) {
            seen.add(clean);
            out.push(clean);
          }
        }
      } catch {}
    }
    out.sort((a, b) => a.localeCompare(b));
    return reply.send({ ok: true, data: out });
  });

  // GET /api/printers/:id/status
  app.get<{ Params: { id: string } }>('/api/printers/:id/status', async (req, reply) => {
    const status = printerManager.getStatus(req.params.id);
    if (!status) return reply.status(404).send({ ok: false, error: 'Printer not connected' });
    return reply.send({ ok: true, data: status });
  });

  // POST /api/printers/:id/reconnect — stop + start fresh adapter
  app.post<{ Params: { id: string } }>('/api/printers/:id/reconnect', async (req, reply) => {
    try {
      await printerManager.reconnect(req.params.id);
      return reply.send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.send({ ok: false, error: message });
    }
  });

  // POST /api/printers/:id/command
  app.post<{ Params: { id: string } }>('/api/printers/:id/command', async (req, reply) => {
    const body = req.body as { command: string; args?: Record<string, unknown> };
    const cmd: PrinterCommand = {
      printerId: req.params.id,
      command: body.command as PrinterCommand['command'],
      args: body.args,
    };
    try {
      await printerManager.sendCommand(cmd);
      return reply.send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.send({ ok: false, error: message });
    }
  });

  // GET /api/printers/:id/camera — MJPEG proxy (Moonraker) or JPEG snapshot (Bambu)
  app.get<{ Params: { id: string } }>('/api/printers/:id/camera', async (req, reply) => {
    const row = db.getPrinter(req.params.id);
    if (!row) return reply.status(404).send({ ok: false, error: 'Printer not found' });

    if (row.protocol === 'bambu') {
      // Snapshot poll: return single JPEG
      const adapter = printerManager.getAdapter(req.params.id);
      if (!(adapter instanceof BambuAdapter)) {
        return reply.status(400).send({ ok: false, error: 'Adapter not bambu' });
      }
      try {
        const jpeg = await adapter.fetchCameraSnapshot();
        reply.raw.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Cache-Control': 'no-store',
        });
        reply.raw.end(jpeg);
        reply.hijack();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({ ok: false, error: message });
      }
      return;
    }

    // Moonraker: prefer adapter.fetchCameraSnapshot (custom URL) → JPEG
    // Else fall back to MJPEG passthrough via cameraUrl()
    const adapter = printerManager.getAdapter(req.params.id);
    if (adapter && typeof adapter.fetchCameraSnapshot === 'function') {
      try {
        const jpeg = await adapter.fetchCameraSnapshot();
        if (jpeg) {
          reply.raw.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
          reply.raw.end(jpeg);
          reply.hijack();
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(502).send({ ok: false, error: message });
      }
    }
    const url = adapter?.cameraUrl();
    if (!url) return reply.status(400).send({ ok: false, error: 'Camera not available' });

    try {
      const upstream = await fetch(url, { signal: AbortSignal.timeout(8000) });
      reply.raw.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=boundarydonotcross',
        'Cache-Control': 'no-store',
      });
      // Pipe body through
      const reader = upstream.body?.getReader();
      if (!reader) throw new Error('no body');
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!reply.raw.write(value)) {
            await new Promise<void>(r => reply.raw.once('drain', () => r()));
          }
        }
        reply.raw.end();
      };
      pump().catch(() => { try { reply.raw.end(); } catch {} });
      reply.hijack();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ ok: false, error: message });
    }
  });

  // POST /api/printers/:id/send — upload gcode + start print (unified across protocols)
  app.post<{ Params: { id: string } }>('/api/printers/:id/send', async (req, reply) => {
    const body = req.body as { jobId: string; startPrint?: boolean };
    if (!body.jobId) return reply.status(400).send({ ok: false, error: 'jobId required' });
    const job = db.getJob(body.jobId);
    if (!job) return reply.status(404).send({ ok: false, error: 'Job not found' });
    if (job.status !== 'completed') return reply.status(400).send({ ok: false, error: 'Job not completed' });

    try {
      const gcodePath = findGcode(job.output_dir!);
      if (!gcodePath) return reply.status(400).send({ ok: false, error: 'No gcode file' });
      const filename = path.basename(gcodePath);
      const printerPath = await printerManager.uploadFile(req.params.id, gcodePath, filename);
      if (body.startPrint !== false) {
        await printerManager.startPrint(req.params.id, printerPath);
      }
      return reply.send({ ok: true, data: { printerPath } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.send({ ok: false, error: message });
    }
  });

  // POST /api/printers/send — legacy single-printer send (deprecated, use /:id/send)
  app.post('/api/printers/send', async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(410).send({ ok: false, error: 'Use POST /api/printers/:id/send instead' });
  });
}

function findGcode(outputDir: string): string | null {
  if (!fs.existsSync(outputDir)) return null;
  const files = fs.readdirSync(outputDir);
  for (const file of files) {
    const fullPath = path.join(outputDir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isFile() && file.endsWith('.gcode')) return fullPath;
    if (stat.isDirectory()) {
      const result = findGcode(fullPath);
      if (result) return result;
    }
  }
  return null;
}
