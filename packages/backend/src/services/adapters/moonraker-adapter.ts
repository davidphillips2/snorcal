import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import type { PrinterCommand, PrinterStatus, PrinterState, PrinterConnectionState, AmsSlot } from '@snorcal/shared';
import type { PrinterAdapter } from './adapter.js';
import { assertSafeUrl } from '../ssrf.js';

export interface MoonrakerAdapterOptions {
  printerId: string;
  ip: string;
  port?: number;            // default 7125
  apiKey?: string;
  webcamPath?: string;      // default /webcam (mjpegstreamer)
  streamUrl?: string;       // full URL override for MJPEG stream
  snapshotUrl?: string;     // full URL override for JPEG snapshot
  // Callbacks set externally if needed
}

interface MoonrakerObjects {
  gcode_move?: { gcode_position: number[]; position: number[]; speed_factor: number };
  extruder?: { temperature: number; target: number; power: number };
  extruder1?: { temperature: number; target: number; power: number };
  extruder2?: { temperature: number; target: number; power: number };
  extruder3?: { temperature: number; target: number; power: number };
  heater_bed?: { temperature: number; target: number; power: number };
  toolhead?: { position: number[]; status: string };
  virtual_sdcard?: { progress: number; is_active: boolean; file_position: number };
  print_stats?: { state: string; filename: string; total_duration: number; print_duration: number; info?: { total_layer?: number; current_layer?: number } };
  display_status?: { progress: number; message: string };
  fan?: { speed: number };
}

export class MoonrakerAdapter implements PrinterAdapter {
  readonly printerId: string;
  readonly protocol = 'moonraker' as const;

  private ip: string;
  private port: number;
  private apiKey?: string;
  private webcamPath: string;
  private streamUrl?: string;
  private snapshotUrl?: string;

  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private destroyed = false;

  private connection: PrinterConnectionState = 'disconnected';
  private status: PrinterStatus | null = null;
  private objects: MoonrakerObjects = {};
  // Snapmaker U1 (and similar custom-Klipper printers) expose per-extruder
  // filament color/type/presence via non-standard `print_task_config` +
  // NFC `filament_detect` objects. Polled via HTTP since not all forks honor
  // WS subscribe on custom objects. Cached between successful polls.
  private filamentSlots: AmsSlot[] | undefined;
  private filamentTimer: NodeJS.Timeout | null = null;
  private static readonly FILAMENT_POLL_MS = 15_000;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatId = 0;
  private lastHeartbeatResponseAt = 0;
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;

  private statusCbs = new Set<(s: PrinterStatus) => void>();
  private connectionCbs = new Set<(c: boolean, r?: string) => void>();

  constructor(opts: MoonrakerAdapterOptions) {
    this.printerId = opts.printerId;
    this.ip = opts.ip;
    this.port = opts.port ?? 7125;
    this.apiKey = opts.apiKey;
    this.webcamPath = opts.webcamPath ?? '/webcam';
    this.streamUrl = opts.streamUrl;
    this.snapshotUrl = opts.snapshotUrl;
  }

  async connect(): Promise<void> {
    this.destroyed = false;
    return new Promise((resolve, reject) => {
      const url = `ws://${this.ip}:${this.port}/websocket`;
      const ws = new WebSocket(url, { headers: this.authHeaders() });
      let settled = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.setConnection(false, err.message);
        reject(err);
      };

      ws.on('open', () => {
        this.ws = ws;
        this.reconnectDelay = 1000;
        this.setConnection(true);
        this.subscribeObjects();
        this.startFilamentPolling();
        this.startHeartbeat();
        if (!settled) { settled = true; resolve(); }
      });

      ws.on('message', (data) => this.handleMessage(data.toString()));

      ws.on('close', () => {
        this.ws = null;
        this.stopHeartbeat();
        this.setConnection(false, 'websocket closed');
        if (!settled) { settled = true; reject(new Error('Connection closed')); return; }
        this.scheduleReconnect();
      });

      ws.on('error', (err) => {
        fail(err);
      });

      // Hard timeout for initial connect
      setTimeout(() => {
        if (!settled) fail(new Error('Connection timeout'));
      }, 5000);
    });
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { 'X-Api-Key': this.apiKey } : {};
  }

  private subscribeObjects(): void {
    if (!this.ws) return;
    // JSON-RPC subscribe
    const msg = {
      jsonrpc: '2.0',
      method: 'printer.objects.subscribe',
      id: 1,
      params: {
        objects: {
          gcode_move: ['gcode_position', 'position', 'speed_factor'],
          extruder: ['temperature', 'target', 'power'],
          extruder1: ['temperature', 'target', 'power'],
          extruder2: ['temperature', 'target', 'power'],
          extruder3: ['temperature', 'target', 'power'],
          heater_bed: ['temperature', 'target', 'power'],
          toolhead: ['position', 'status'],
          virtual_sdcard: ['progress', 'is_active', 'file_position'],
          print_stats: ['state', 'filename', 'total_duration', 'print_duration', 'info'],
          display_status: ['progress', 'message'],
          fan: ['speed'],
        },
      },
    };
    this.ws.send(JSON.stringify(msg));
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (process.env.DEBUG_PRINTER) console.debug('[Moonraker]', raw.slice(0, 200));

    // Subscription response or status update
    if (msg.method === 'notify_status_update' && msg.params?.[0]) {
      this.mergeObjects(msg.params[0]);
      this.recomputeStatus();
    } else if (msg.result?.status) {
      this.mergeObjects(msg.result.status);
      this.recomputeStatus();
    } else if (msg.id === this.heartbeatId && msg.result !== undefined) {
      // Heartbeat pong — any JSON-RPC response to our ping counts as alive.
      this.lastHeartbeatResponseAt = Date.now();
    }
  }

  /** Send JSON-RPC ping every HEARTBEAT_INTERVAL_MS. If moonraker goes silent
   *  (half-open TCP, NAT timeout), force-close so scheduleReconnect fires. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastHeartbeatResponseAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const stale = Date.now() - this.lastHeartbeatResponseAt;
      if (stale > MoonrakerAdapter.HEARTBEAT_INTERVAL_MS * 2.5) {
        console.warn(`[Moonraker ${this.ip}] no heartbeat response in ${Math.round(stale / 1000)}s, force-closing half-open WS`);
        this.ws.terminate();
        return;
      }
      this.heartbeatId = Math.floor(Math.random() * 1e9);
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'server.ping', id: this.heartbeatId }));
    }, MoonrakerAdapter.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private mergeObjects(patch: Record<string, Record<string, unknown>>): void {
    for (const [obj, fields] of Object.entries(patch)) {
      const cur = (this.objects as any)[obj] ?? {};
      (this.objects as any)[obj] = { ...cur, ...fields };
    }
  }

  private recomputeStatus(): void {
    const ps = this.objects.print_stats;
    const stateMap: Record<string, PrinterState> = {
      standby: 'idle', idle: 'idle',
      printing: 'printing',
      paused: 'paused',
      complete: 'complete',
      cancelled: 'idle', error: 'error',
    };
    const state = ps ? (stateMap[ps.state] ?? 'idle') : 'idle';

    const extruder = this.objects.extruder;
    const extruders = [extruder, this.objects.extruder1, this.objects.extruder2, this.objects.extruder3];
    const bed = this.objects.heater_bed;
    const vsd = this.objects.virtual_sdcard;
    const disp = this.objects.display_status;
    const fan = this.objects.fan;

    // Prefer display_status.progress (M73-driven, time-accurate) over
    // virtual_sdcard.progress (byte-position-based, misleading early in
    // print due to varying gcode density). Fall back to vsd if no display.
    const progress = disp?.progress ?? vsd?.progress ?? 0;
    // ETA from print_duration (pure print time, excludes heat-up/level
    // overhead). total_duration included heating + ABL which inflate ETA
    // early in the print. Only compute when progress > 2% — before that
    // the extrapolation is too noisy.
    const etaSec = ps && progress > 0.02
      ? Math.max(0, (ps.print_duration / progress) * (1 - progress))
      : undefined;

    // Build hotends array — only include hotends that the printer actually reports.
    const hotends = extruders
      .filter((e): e is { temperature: number; target: number; power: number } => !!e)
      .map((e) => ({ current: e.temperature, target: e.target }));

    this.status = {
      printerId: this.printerId,
      protocol: 'moonraker',
      connection: this.connection,
      state,
      progress,
      layer: ps?.info?.current_layer,
      totalLayers: ps?.info?.total_layer,
      temps: {
        bed: bed?.temperature,
        bedTarget: bed?.target,
        hotend: extruder?.temperature,
        hotendTarget: extruder?.target,
        hotends: hotends.length > 0 ? hotends : undefined,
      },
      fanSpeed: fan ? Math.round(fan.speed * 100) : undefined,
      etaSec,
      file: ps?.filename,
      ams: this.filamentSlots,
      updatedAt: new Date().toISOString(),
    };
    this.emitStatus();
  }

  /**
   * Poll Snapmaker U1's custom Klipper objects for per-extruder filament
   * info. Stock U1 firmware exposes `print_task_config` (color/type/vendor/
   * loaded arrays) + `filament_detect` (NFC RFID tags). Non-Snapmaker
   * Moonraker printers return empty → cache stays undefined → no-op.
   * Mirrors u1-slicer-bridge `query_filament_config` (moonraker.py:266).
   */
  private startFilamentPolling(): void {
    if (this.filamentTimer) return;
    const tick = async () => {
      try {
        const res = await this.http('GET', '/printer/objects/query?print_task_config=&filament_detect=');
        if (!res.ok) return;
        const json = await res.json() as any;
        const status = json?.result?.status ?? {};
        const config = status.print_task_config;
        if (!config) { return; }
        const colors: string[] = Array.isArray(config.filament_color_rgba) ? config.filament_color_rgba : [];
        const types: string[] = Array.isArray(config.filament_type) ? config.filament_type : [];
        const vendors: string[] = Array.isArray(config.filament_vendor) ? config.filament_vendor : [];
        const exists: boolean[] = Array.isArray(config.filament_exist) ? config.filament_exist : [];
        const nfcInfo: any[] = status.filament_detect?.info ?? [];
        const count = Math.min(exists.length, 4);
        if (count === 0) return;
        const slots: AmsSlot[] = [];
        for (let i = 0; i < count; i++) {
          const loaded = exists[i] !== false;
          if (!loaded) continue; // skip empty bays — UI shows only loaded spools
          const rgba = typeof colors[i] === 'string' ? colors[i].replace(/^#/, '') : '';
          const color = rgba.length >= 6 ? rgba.slice(0, 8).toUpperCase().padEnd(8, 'F') : undefined;
          let brand = vendors[i] || undefined;
          // NFC enrichment: RFID tag reports real manufacturer when vendor is unknown.
          const nfc = nfcInfo[i];
          if (nfc && typeof nfc === 'object' && nfc.VERSION > 0) {
            const mfr = nfc.MANUFACTURER;
            if (mfr && mfr !== 'NONE') brand = mfr;
          }
          slots.push({
            id: i,
            trayId: i,
            color,
            type: types[i] || undefined,
            brand,
          });
        }
        // Only emit if changed (avoid status spam every 15s).
        const prev = JSON.stringify(this.filamentSlots ?? []);
        const next = JSON.stringify(slots);
        if (prev !== next) {
          this.filamentSlots = slots.length > 0 ? slots : undefined;
          this.recomputeStatus();
        }
      } catch (e) {
        if (process.env.DEBUG_PRINTER) console.debug('[Moonraker] filament poll error:', e instanceof Error ? e.message : e);
      } finally {
        if (!this.destroyed) {
          this.filamentTimer = setTimeout(tick, MoonrakerAdapter.FILAMENT_POLL_MS);
        }
      }
    };
    tick();
  }

  private emitStatus(): void {
    if (!this.status) return;
    for (const cb of this.statusCbs) cb(this.status);
  }

  private setConnection(connected: boolean, reason?: string): void {
    this.connection = connected ? 'connected' : 'disconnected';
    for (const cb of this.connectionCbs) cb(connected, reason);
    if (this.status) {
      this.status.connection = this.connection;
      this.emitStatus();
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) return;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {/* swallow, will retry */});
    }, this.reconnectDelay);
  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.filamentTimer) { clearTimeout(this.filamentTimer); this.filamentTimer = null; }
    this.stopHeartbeat();
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    this.setConnection(false, 'disconnected by user');
  }

  getStatus(): PrinterStatus | null {
    return this.status;
  }

  onStatus(cb: (s: PrinterStatus) => void): () => void {
    this.statusCbs.add(cb);
    return () => { this.statusCbs.delete(cb); };
  }

  onConnection(cb: (c: boolean, r?: string) => void): () => void {
    this.connectionCbs.add(cb);
    return () => { this.connectionCbs.delete(cb); };
  }

  private async http(method: string, p: string, init?: RequestInit): Promise<Response> {
    const url = `http://${this.ip}:${this.port}${p}`;
    const headers: Record<string, string> = { ...(init?.headers as Record<string, string> || {}) };
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;
    return fetch(url, { ...init, method, headers, signal: AbortSignal.timeout(8000) });
  }

  async sendCommand(cmd: PrinterCommand): Promise<void> {
    switch (cmd.command) {
      case 'pause':       await this.http('POST', '/printer/print/pause'); return;
      case 'resume':      await this.http('POST', '/printer/print/resume'); return;
      case 'cancel':      await this.http('POST', '/printer/print/cancel'); return;
      case 'home': {
        const axes = (cmd.args?.axes as string[]) ?? ['x', 'y', 'z'];
        const g = 'G28 ' + axes.map(a => a.toUpperCase()).join(' ');
        await this.sendGcode(g);
        return;
      }
      case 'jog': {
        const axis = String(cmd.args?.axis).toUpperCase();
        const amount = Number(cmd.args?.amount);
        await this.sendGcode(`G1 ${axis}${amount} F6000`);
        return;
      }
      case 'set_temp': {
        const heater = String(cmd.args?.heater);
        const value = Number(cmd.args?.value);
        const g = heater === 'bed' ? `M140 S${value}` : `M104 S${value}`;
        await this.sendGcode(g);
        return;
      }
      case 'send_gcode': {
        await this.sendGcode(String(cmd.args?.script));
        return;
      }
      case 'start': {
        const filePath = String(cmd.args?.file ?? '');
        if (!filePath) throw new Error('file required for start');
        await this.http('POST', `/printer/print/start?filename=${encodeURIComponent(filePath)}`);
        return;
      }
      default: throw new Error(`Unsupported command: ${cmd.command}`);
    }
  }

  private async sendGcode(script: string): Promise<void> {
    await this.http('POST', `/printer/gcode/script?script=${encodeURIComponent(script)}`);
  }

  async uploadFile(localPath: string, filename: string): Promise<string> {
    // Use the global (undici) FormData + Buffer — the third-party `form-data`
    // package produces a Node stream that the WHATWG global fetch can't
    // serialize, and Moonraker rejects the resulting body with
    // "File Upload Parsing Failed".
    const buffer = fs.readFileSync(localPath);
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: 'application/octet-stream' }), filename);
    form.append('root', 'gcodes');
    form.append('path', '/');

    const url = `http://${this.ip}:${this.port}/server/files/upload`;
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;
    // Let fetch set the multipart boundary — don't copy form.getHeaders().

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Upload failed: HTTP ${res.status} ${txt}`);
    }
    const json = await res.json() as any;
    return json.result?.item?.path || filename;
  }

  async startPrint(printerPath: string): Promise<void> {
    await this.http('POST', `/printer/print/start?filename=${encodeURIComponent(printerPath)}`);
  }

  cameraUrl(): string | null {
    return this.streamUrl ?? `http://${this.ip}:${this.port}${this.webcamPath}/?action=stream`;
  }

  /** Per-adapter snapshot fetch — used by camera route when snapshotUrl is set. */
  async fetchCameraSnapshot(): Promise<Buffer | null> {
    if (!this.snapshotUrl) return null;
    // User-configured camera URL — allowPrivate (cameras on LAN) but still
    // block metadata hosts / non-http(s) schemes, and disable redirect follows.
    assertSafeUrl(this.snapshotUrl, { allowPrivate: true });
    const res = await fetch(this.snapshotUrl, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(6000),
      redirect: 'manual',
    });
    if (!res.ok) throw new Error(`camera HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  getSnapshotUrl(): string | null { return this.snapshotUrl ?? null; }
}
