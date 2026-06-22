import fs from 'node:fs';
import path from 'node:path';
import FormData from 'form-data';
import WebSocket from 'ws';
import type { PrinterCommand, PrinterStatus, PrinterState, PrinterConnectionState } from '@snorcal/shared';
import type { PrinterAdapter } from './adapter.js';

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
        if (!settled) { settled = true; resolve(); }
      });

      ws.on('message', (data) => this.handleMessage(data.toString()));

      ws.on('close', () => {
        this.ws = null;
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
    }
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

    const progress = vsd?.progress ?? disp?.progress ?? 0;
    const etaSec = ps && vsd && vsd.progress > 0
      ? Math.max(0, (ps.total_duration / vsd.progress) * (1 - vsd.progress))
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
      updatedAt: new Date().toISOString(),
    };
    this.emitStatus();
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
    const stats = fs.statSync(localPath);
    const stream = fs.createReadStream(localPath);
    const form = new FormData();
    form.append('file', stream as any, { filename, knownLength: stats.size });
    form.append('root', 'gcodes');
    form.append('path', '/');

    const url = `http://${this.ip}:${this.port}/server/files/upload`;
    const headers: Record<string, string> = { ...(form.getHeaders() as Record<string, string>) };
    if (this.apiKey) headers['X-Api-Key'] = this.apiKey;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: form as any,
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
    const res = await fetch(this.snapshotUrl, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`camera HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  getSnapshotUrl(): string | null { return this.snapshotUrl ?? null; }
}
