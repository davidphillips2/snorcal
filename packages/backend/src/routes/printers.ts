import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { discoverDevices } from '../services/ssdp-discovery.js';
import { printerManager } from '../services/printer-manager.js';
import { BambuAdapter } from '../services/adapters/bambu-adapter.js';
import { findGcodeFile, extractGcodeFrom3mf } from '../services/gcode-utils.js';
import { parseGcodeFilaments } from '../services/gcode-filaments.js';
import { rewriteGcodeToolMapping, mappingIsNoop } from '../services/gcode-rewriter.js';
import { getJobsDir, ensureDir } from '../services/model-parser.js';
import type { PrinterCommand, PrinterProtocol } from '@snorcal/shared';

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
    manualSlots: row.manual_slots ?? 0,
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
  const engines = ['orcaslicer', 'bambustudio'];
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
    { port: 8080, path: '/printer/info', type: 'Moonraker/Klipper' },
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
    { port: 8080, type: 'Possible Moonraker/Klipper' },
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
      manualSlots?: number;
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
      manual_slots: body.manualSlots ?? 0,
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
    const body = req.body as {
      name?: string;
      ip?: string;
      port?: number;
      access_code?: string | null;
      api_key?: string | null;
      camera_stream_url?: string | null;
      camera_snapshot_url?: string | null;
      model?: string | null;
    };
    const row = db.getPrinter(req.params.id);
    if (!row) return reply.status(404).send({ ok: false, error: 'Printer not found' });

    db.updatePrinterFields(req.params.id, body);
    const updated = db.getPrinter(req.params.id)!;

    // Reconnect if connection params changed (adapter picks up new IP/port/keys)
    const connectionChanged = ['ip', 'port', 'access_code', 'api_key'].some(k => k in body);
    if (connectionChanged) {
      try { await printerManager.reconnect(req.params.id); } catch {}
    }
    return reply.send({ ok: true, data: toPrinterRecord(updated) });
  });

  // GET /api/printers/models — unique machine family names across all known engines.
  // Strips nozzle variants ("0.4 nozzle", "(0.6 nozzle)") so each printer model
  // appears once regardless of nozzle options. Merges DB-loaded slicer profiles
  // with a built-in list of common printers so the picker isn't sparse when the
  // sidecar hasn't indexed many profiles.
  const BUILTIN_PRINTER_MODELS = [
    // Bambu Lab
    'Bambu Lab X1 Carbon', 'Bambu Lab X1E', 'Bambu Lab P1S', 'Bambu Lab P1P',
    'Bambu Lab A1', 'Bambu Lab A1 mini', 'Bambu Lab H2D',
    // Voron
    'Voron 2.4', 'Voron Trident', 'Voron 0.2', 'Voron Switchwire',
    // RatRig
    'RatRig V-Core 3', 'RatRig V-Core 4', 'RatRig V-Minion',
    // Creality
    'Creality Ender 3', 'Creality Ender 3 V3', 'Creality K1', 'Creality K1 Max', 'Creality CR-10',
    'Creality Hi', 'Creality Spark X i7',
    // Snapmaker
    'Snapmaker U1', 'Snapmaker J1', 'Snapmaker J1s', 'Snapmaker Artisan', 'Snapmaker 2.0 A350T',
    // Prusa
    'Prusa MK4', 'Prusa MK3S+', 'Prusa XL', 'Prusa MINI+',
    // Sofabedfox / Anycubic / Anker / Elegoo
    'Sofabedfox Galaxy', 'Anycubic Kobra 2', 'Anycubic Kobra 3', 'AnkerMake M5',
    'Elegoo Neptune 4', 'Elegoo Centauri Carbon',
  ];
  app.get('/api/printers/models', async (_req, reply) => {
    const engines = ['orcaslicer', 'bambustudio'];
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
    for (const m of BUILTIN_PRINTER_MODELS) {
      if (!seen.has(m)) { seen.add(m); out.push(m); }
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

  // POST /api/printers/:id/webrtc — pass-through WebRTC signaling relay.
  // Snapmaker/go2rtc uses WHEP-like server-initiated flow with multiple POSTs:
  //   {type:'request'} → server returns offer
  //   {type:'answer', id, sdp} → browser posts its answer
  //   {type:'remote_candidate', id, candidates:[...]} → trickle ICE
  // Browser can't POST cross-origin (no CORS), so we relay each call verbatim.
  app.post<{ Params: { id: string } }>('/api/printers/:id/webrtc', async (req, reply) => {
    const row = db.getPrinter(req.params.id);
    if (!row) return reply.status(404).send({ ok: false, error: 'Printer not found' });
    const streamUrl = row.camera_stream_url;
    if (!streamUrl || !/\/(webrtc|stream)(\?|$|\/)/.test(streamUrl)) {
      return reply.status(400).send({ ok: false, error: 'No WebRTC stream URL configured' });
    }
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ ok: false, error: 'Missing JSON body' });
    }

    try {
      const upstream = await fetch(streamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      const text = await upstream.text();
      if (!upstream.ok) {
        return reply.status(502).send({ ok: false, error: `upstream ${upstream.status}: ${text.slice(0, 200)}` });
      }
      reply.header('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
      return reply.send(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ ok: false, error: message });
    }
  });

  // POST /api/printers/:id/send — upload gcode + start print (unified across protocols)
  // Body:
  //   jobId: string
  //   startPrint?: boolean (default true)
  //   filamentMapping?: number[]  // gcode filament idx → physical slot idx
  //                               // Bambu: 1-indexed AMS tray (0=skip). use_ams auto-enabled when any >0.
  //                               // Moonraker/manualSlots: T-code rewrite (Tx → Ty) before upload
  app.post<{ Params: { id: string } }>('/api/printers/:id/send', async (req, reply) => {
    const body = req.body as { jobId: string; startPrint?: boolean; filamentMapping?: number[] };
    if (!body.jobId) return reply.status(400).send({ ok: false, error: 'jobId required' });
    const job = db.getJob(body.jobId);
    if (!job) return reply.status(404).send({ ok: false, error: 'Job not found' });
    if (job.status !== 'completed') return reply.status(400).send({ ok: false, error: 'Job not completed' });

    try {
      const gcodePath = findGcodeFile(job.output_dir!);
      if (!gcodePath) return reply.status(400).send({ ok: false, error: 'No gcode file' });

      const printer = db.getPrinter(req.params.id);
      if (!printer) return reply.status(404).send({ ok: false, error: 'Printer not found' });

      const mapping = Array.isArray(body.filamentMapping) ? body.filamentMapping : null;
      const hasMapping = mapping && mapping.length > 0;

      // Decide if we need to rewrite gcode T-codes.
      // Bambu: ams_mapping sent in start-print MQTT payload — no gcode rewrite.
      // Snapmaker U1 (no AMS, 4 direct spools), Moonraker, generic Klipper with
      // manual_slots: rewrite Tx per mapping before upload.
      let uploadPath = gcodePath;
      let tempPath: string | null = null;
      const supportsNativeMapping = printer.protocol === 'bambu';
      if (hasMapping && !supportsNativeMapping) {
        if (!mappingIsNoop(mapping!)) {
          tempPath = await rewriteGcodeToolMapping(gcodePath, mapping!);
          uploadPath = tempPath;
        }
      }

      try {
        const filename = path.basename(uploadPath);
        const printerPath = await printerManager.uploadFile(req.params.id, uploadPath, filename);
        if (body.startPrint !== false) {
          if (hasMapping && supportsNativeMapping) {
            // Pass ams_mapping through to MQTT start command
            await printerManager.startPrint(req.params.id, printerPath, { amsMapping: mapping });
          } else {
            await printerManager.startPrint(req.params.id, printerPath);
          }
        }
        return reply.send({ ok: true, data: { printerPath } });
      } finally {
        if (tempPath) {
          try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.send({ ok: false, error: message });
    }
  });

  // POST /api/printers/:id/stage-file — accept an uploaded .gcode or .gcode.3mf,
  // stash it under <jobsDir>/uploads/<uuid>/, parse filament metadata so the
  // caller can show a remap UI before the actual send. Returns a stageId the
  // client posts back to /send-file. Stage dirs are removed by /send-file in
  // a finally block; leaked dirs are tolerated if the client never sends.
  app.post<{ Params: { id: string } }>('/api/printers/:id/stage-file', async (req, reply) => {
    const printer = db.getPrinter(req.params.id);
    if (!printer) return reply.code(404).send({ ok: false, error: 'Printer not found' });

    const data = await req.file();
    if (!data) return reply.code(400).send({ ok: false, error: 'No file uploaded' });

    try {
      const buffer = await data.toBuffer();
      const filename = data.filename || 'upload.gcode';
      const lower = filename.toLowerCase();
      const isGcode3mf = lower.endsWith('.gcode.3mf') || lower.endsWith('.3mf');

      const stageId = randomUUID();
      const stageDir = path.join(getJobsDir(), 'uploads', stageId);
      ensureDir(stageDir);
      const stagedPath = path.join(stageDir, filename);
      fs.writeFileSync(stagedPath, buffer);

      let gcodePathForParse = stagedPath;
      let plates: number[] = [];
      if (isGcode3mf) {
        const ex = await extractGcodeFrom3mf(buffer);
        plates = ex.plates;
        // Save extracted gcode alongside original so /send-file can reuse it
        // without re-doing the JSZip work. File name is fixed so we can find it.
        const extractedPath = path.join(stageDir, '__extracted.gcode');
        fs.writeFileSync(extractedPath, ex.text);
        gcodePathForParse = extractedPath;
      }

      const filaments = parseGcodeFilaments(gcodePathForParse);
      return reply.send({
        ok: true,
        data: { stageId, filename, isGcode3mf, plates, filaments },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.send({ ok: false, error: message });
    }
  });

  // POST /api/printers/:id/send-file — finalize a staged upload: resolve
  // protocol-specific transform (extract inner gcode for non-Bambu, rewrite
  // T-codes if filament mapping supplied), push to printer's storage, and
  // optionally kick off a print. Stage dir is always removed in finally.
  app.post<{ Params: { id: string } }>('/api/printers/:id/send-file', async (req, reply) => {
    const body = req.body as { stageId?: string; startPrint?: boolean; filamentMapping?: number[]; plate?: number };
    if (!body.stageId) return reply.code(400).send({ ok: false, error: 'stageId required' });

    const printer = db.getPrinter(req.params.id);
    if (!printer) return reply.code(404).send({ ok: false, error: 'Printer not found' });

    const stageDir = path.join(getJobsDir(), 'uploads', body.stageId);
    if (!fs.existsSync(stageDir)) {
      return reply.code(400).send({ ok: false, error: 'Staged file expired' });
    }

    try {
      const stagedName = fs.readdirSync(stageDir).find(f => !f.startsWith('.') && f !== '__extracted.gcode');
      if (!stagedName) throw new Error('Empty stage directory');
      const stagedPath = path.join(stageDir, stagedName);
      const isGcode3mf = /\.gcode\.3mf$/i.test(stagedName) || /\.3mf$/i.test(stagedName);
      const plateNum = body.plate ?? 1;
      const startPrint = body.startPrint !== false;
      const mapping = Array.isArray(body.filamentMapping) ? body.filamentMapping : null;
      const supportsNativeMapping = printer.protocol === 'bambu';

      let uploadPath = stagedPath;
      let uploadFilename = stagedName;
      let bambuPlateArg: string | undefined;

      if (isGcode3mf) {
        if (supportsNativeMapping) {
          // Bambu reads .gcode.3mf natively. Pass plate path for start-print.
          bambuPlateArg = `Metadata/plate_${plateNum}.gcode`;
        } else {
          // Klipper/Moonraker can't read 3MF — pull inner gcode out.
          // Reuse the extracted file from stage if present, else re-extract.
          const extractedPath = path.join(stageDir, '__extracted.gcode');
          if (fs.existsSync(extractedPath)) {
            uploadPath = extractedPath;
          } else {
            const buffer = fs.readFileSync(stagedPath);
            const ex = await extractGcodeFrom3mf(buffer, plateNum);
            fs.writeFileSync(extractedPath, ex.text);
            uploadPath = extractedPath;
          }
          uploadFilename = stagedName.replace(/\.gcode\.3mf$/i, '.gcode').replace(/\.3mf$/i, '.gcode');
        }
      }

      // T-code rewrite for non-Bambu with user-supplied mapping
      if (mapping && mapping.length > 0 && !supportsNativeMapping) {
        if (!mappingIsNoop(mapping)) {
          uploadPath = await rewriteGcodeToolMapping(uploadPath, mapping);
        }
      }

      const printerPath = await printerManager.uploadFile(req.params.id, uploadPath, uploadFilename);

      if (startPrint) {
        if (mapping && mapping.length > 0 && supportsNativeMapping) {
          await printerManager.startPrint(req.params.id, printerPath, {
            amsMapping: mapping,
            ...(bambuPlateArg ? { plate: bambuPlateArg } : {}),
          });
        } else if (bambuPlateArg) {
          await printerManager.startPrint(req.params.id, printerPath, { plate: bambuPlateArg });
        } else {
          await printerManager.startPrint(req.params.id, printerPath);
        }
      }

      return reply.send({ ok: true, data: { printerPath } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.send({ ok: false, error: message });
    } finally {
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // POST /api/printers/send — legacy single-printer send (deprecated, use /:id/send)
  app.post('/api/printers/send', async (req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(410).send({ ok: false, error: 'Use POST /api/printers/:id/send instead' });
  });
}
