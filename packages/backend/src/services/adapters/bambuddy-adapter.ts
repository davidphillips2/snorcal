import fs from 'node:fs';
import WebSocket from 'ws';
import type { PrinterCommand, PrinterStatus, PrinterState, PrinterConnectionState, AmsSlot, PrintOptions } from '@snorcal/shared';
import type { PrinterAdapter } from './adapter.js';
import { assertSafeUrl } from '../ssrf.js';
import { wrapGcodeAs3mf } from '../gcode-utils.js';

export interface BambuddyAdapterOptions {
  printerId: string;           // snorcal printer UUID
  bambuddyUrl: string;         // base URL, e.g. http://100.122.105.27:8000
  bambuddyPrinterId: number;   // integer printer id on the bambuddy side
  apiKey?: string;             // bambuddy API key (bb_...), omit if auth disabled
}

/**
 * Bambu printer reached through a bambuddy proxy instead of direct MQTT.
 *
 * Why this exists: the Bambu broker drops concurrent MQTT clients that
 * authenticate with the same bblp/access-code. Bambuddy holds that single
 * connection; a second direct-MQTT client (snorcal) gets no CONNACK. Routing
 * through bambuddy's WebSocket avoids the conflict — bambuddy already parses
 * the printer MQTT and republishes status over `/api/v1/ws`.
 *
 * Scope: read-only status monitoring + camera snapshot + pause/resume/cancel.
 * Upload / start-print need direct FTP to the printer and are out of scope
 * (throw). Add later if bambuddy exposes a file-relay endpoint.
 *
 * WS lifecycle (bambuddy core/websocket.py):
 *   - Auth enabled  → mint a token via POST /api/v1/auth/ws-token (X-API-Key),
 *                     append as ?token=<value>. Token valid 60min; refresh
 *                     before expiry. Close code 4401 = expired → re-mint.
 *   - Auth disabled → connect with no token.
 *   - On connect:   pushes printer_status for ALL printers; we filter to ours.
 *   - Keepalive:    send {type:"ping"} → {type:"pong"} every 30s.
 */
export class BambuddyAdapter implements PrinterAdapter {
  readonly printerId: string;
  readonly protocol = 'bambu' as const;

  private baseUrl: string;
  private bambuddyPrinterId: number;
  private apiKey?: string;

  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private pingTimer: NodeJS.Timeout | null = null;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private lastPongAt = 0;

  private connection: PrinterConnectionState = 'disconnected';
  private status: PrinterStatus | null = null;
  private wsToken: string | null = null;
  private tokenExpiresAt = 0;

  private statusCbs = new Set<(s: PrinterStatus) => void>();
  private connectionCbs = new Set<(c: boolean, r?: string) => void>();

  // Reuse the Bambu gcode_state → PrinterState mapping. Bambuddy passes the
  // raw printer state string through (RUNNING / PAUSE / IDLE / FINISH / ...).
  private static readonly STATE_MAP: Record<string, PrinterState> = {
    RUNNING: 'printing',
    PAUSE: 'paused',
    PAUSED: 'paused',
    IDLE: 'idle',
    FINISH: 'complete',
    FAILED: 'error',
    SLICING: 'idle',
    PREPARE: 'printing',
  };

  private static readonly RECONNECT_DELAY_MAX = 30_000;
  private static readonly PING_INTERVAL_MS = 30_000;
  private static readonly TOKEN_REFRESH_MS = 50 * 60 * 1000; // refresh at 50min (60min max)

  constructor(opts: BambuddyAdapterOptions) {
    this.printerId = opts.printerId;
    this.baseUrl = opts.bambuddyUrl.replace(/\/+$/, '');
    this.bambuddyPrinterId = opts.bambuddyPrinterId;
    this.apiKey = opts.apiKey;
  }

  async connect(): Promise<void> {
    this.destroyed = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.setConnection(false, err.message);
        reject(err);
      };

      this.openSocket()
        .then(socket => {
          this.ws = socket;
          this.reconnectDelay = 1000;
          // connection state set in onOpen; resolve here once socket is up.
          if (!settled) { settled = true; resolve(); }
        })
        .catch(fail);

      // Hard timeout for the initial connect (token mint + ws handshake).
      setTimeout(() => { if (!settled) fail(new Error('bambuddy connect timeout')); }, 10000);
    });
  }

  /**
   * Mint a WS token (if auth enabled) and open the WebSocket. Resolves once
   * the socket is open; the caller wires onMessage/onClose.
   */
  private async openSocket(): Promise<WebSocket> {
    // Refresh token if we have an API key (auth enabled). The endpoint accepts
    // X-API-Key and returns {token}. If no key, assume auth disabled.
    if (this.apiKey) {
      this.wsToken = await this.mintToken();
      this.tokenExpiresAt = Date.now() + BambuddyAdapter.TOKEN_REFRESH_MS;
    }

    const wsUrl = this.wsUrl();
    if (process.env.DEBUG_PRINTER) console.debug('[Bambuddy] connecting', wsUrl.replace(/token=[^&]*/, 'token=***'));
    const ws = new WebSocket(wsUrl);

    return new Promise<WebSocket>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        this.onOpen();
        resolve(ws);
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        ws.off('open', onOpen);
        ws.off('error', onError);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
      ws.on('message', (data) => this.onMessage(data.toString()));
      ws.on('close', (code, reason) => this.onClose(code, reason.toString()));
    });
  }

  private wsUrl(): string {
    const http = this.baseUrl;
    const wsBase = http.replace(/^http/, 'ws');
    const path = `${wsBase}/api/v1/ws`;
    return this.wsToken ? `${path}?token=${encodeURIComponent(this.wsToken)}` : path;
  }

  /** POST /api/v1/auth/ws-token with X-API-Key → {token}. */
  private async mintToken(): Promise<string> {
    assertSafeUrl(`${this.baseUrl}/api/v1/auth/ws-token`, { allowPrivate: true });
    const res = await fetch(`${this.baseUrl}/api/v1/auth/ws-token`, {
      method: 'POST',
      headers: this.apiKey ? { 'X-API-Key': this.apiKey } : {},
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
    });
    if (!res.ok) throw new Error(`bambuddy ws-token HTTP ${res.status}`);
    const json = await res.json() as { token?: string };
    if (!json.token) throw new Error('bambuddy ws-token: no token in response');
    return json.token;
  }

  private onOpen(): void {
    this.setConnection(true);
    this.startPing();
    this.startTokenRefresh();
    if (process.env.DEBUG_PRINTER) console.debug('[Bambuddy] ws open');
  }

  private onMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (process.env.DEBUG_PRINTER) console.debug('[Bambuddy] msg:', raw.slice(0, 200));

    if (msg.type === 'pong') {
      this.lastPongAt = Date.now();
      return;
    }
    if (msg.type === 'printer_status' && msg.printer_id === this.bambuddyPrinterId) {
      this.applyStatus(msg.data);
    }
  }

  private onClose(code: number, reason: string): void {
    this.ws = null;
    this.stopPing();
    this.stopTokenRefresh();
    this.setConnection(false, `bambuddy ws closed (${code})`);

    if (this.destroyed) return;

    // 4401 = auth token expired/invalid. Clear it so the reconnect re-mints.
    if (code === 4401) {
      this.wsToken = null;
      this.tokenExpiresAt = 0;
    }
    if (process.env.DEBUG_PRINTER) console.debug('[Bambuddy] ws closed', code, reason);
    this.scheduleReconnect();
  }

  private applyStatus(data: any): void {
    if (!data || typeof data !== 'object') return;
    const stateRaw = typeof data.state === 'string' ? data.state : 'IDLE';
    const state = BambuddyAdapter.STATE_MAP[stateRaw] ?? 'idle';
    const temps = data.temperatures ?? {};

    this.status = {
      printerId: this.printerId,
      protocol: 'bambu',
      connection: this.connection,
      state,
      progress: typeof data.progress === 'number' ? data.progress / 100 : undefined,
      layer: data.layer_num,
      totalLayers: data.total_layers,
      temps: {
        bed: temps.bed,
        bedTarget: temps.bed_target,
        hotend: temps.nozzle,
        hotendTarget: temps.nozzle_target,
      },
      fanSpeed: data.cooling_fan_speed,
      etaSec: typeof data.remaining_time === 'number' ? data.remaining_time * 60 : undefined,
      file: data.subtask_name ?? data.gcode_file,
      ams: this.parseAms(data.ams),
      updatedAt: new Date().toISOString(),
    };
    this.emitStatus();
  }

  /** Parse bambuddy AMS units → snorcal AmsSlot[]. Same shape as direct Bambu. */
  private parseAms(units: any): AmsSlot[] | undefined {
    if (!Array.isArray(units)) return undefined;
    const slots: AmsSlot[] = [];
    for (const unit of units) {
      const unitId = unit.id ?? 0;
      const trays = Array.isArray(unit.tray) ? unit.tray : [];
      for (const tray of trays) {
        if (!tray || tray.id === undefined) continue;
        // Bambuddy marks loaded trays via state (3 = loaded) or tray_type.
        // Mirror the direct-adapter filter so empty trays don't render.
        const loaded = tray.state === 3
          || (typeof tray.tray_type === 'string' && tray.tray_type.length > 0 && tray.tray_type !== 'empty')
          || (typeof tray.remain === 'number' && tray.remain > 0);
        if (!loaded) continue;
        slots.push({
          id: unitId,
          trayId: tray.id,
          type: tray.tray_type,
          color: tray.tray_color,
          brand: tray.tray_sub_brands,
          remain: typeof tray.remain === 'number' && tray.remain >= 0 ? tray.remain : undefined,
        });
      }
    }
    return slots.length ? slots : undefined;
  }

  private startPing(): void {
    this.stopPing();
    this.lastPongAt = Date.now(); // grace period; don't declare dead before first pong cycle
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      // Heartbeat watchdog: if no pong in 2.5 intervals, TCP is half-open
      // (bambuddy silent-dead, NAT timed out, etc). onClose doesn't fire on
      // half-open sockets — force terminate so reconnect can kick in.
      const stale = Date.now() - this.lastPongAt;
      if (stale > BambuddyAdapter.PING_INTERVAL_MS * 2.5) {
        console.warn(`[Bambuddy] no pong in ${Math.round(stale / 1000)}s, force-closing half-open WS`);
        this.ws.terminate();
        return;
      }
      this.ws.send(JSON.stringify({ type: 'ping' }));
    }, BambuddyAdapter.PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  /** Refresh the WS token before it expires, without dropping the connection. */
  private startTokenRefresh(): void {
    this.stopTokenRefresh();
    if (!this.apiKey) return; // no token to refresh (auth disabled)
    this.tokenRefreshTimer = setInterval(async () => {
      if (Date.now() < this.tokenExpiresAt) return;
      try {
        this.wsToken = await this.mintToken();
        this.tokenExpiresAt = Date.now() + BambuddyAdapter.TOKEN_REFRESH_MS;
        if (process.env.DEBUG_PRINTER) console.debug('[Bambuddy] token refreshed');
      } catch (e) {
        // Refresh failed — let the connection ride; bambuddy closes with 4401
        // on expiry and onClose re-mints + reconnects.
        if (process.env.DEBUG_PRINTER) console.debug('[Bambuddy] token refresh failed:', e instanceof Error ? e.message : e);
      }
    }, 60_000);
  }

  private stopTokenRefresh(): void {
    if (this.tokenRefreshTimer) { clearInterval(this.tokenRefreshTimer); this.tokenRefreshTimer = null; }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer) return;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, BambuddyAdapter.RECONNECT_DELAY_MAX);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket()
        .then(ws => {
          this.ws = ws;
          this.reconnectDelay = 1000;
        })
        .catch(() => { /* scheduleReconnect will be called by onClose if the
                          socket opened then dropped; if openSocket itself
                          rejected, retry here. */
          if (!this.destroyed) this.scheduleReconnect();
        });
    }, this.reconnectDelay);
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

  getStatus(): PrinterStatus | null { return this.status; }

  onStatus(cb: (s: PrinterStatus) => void): () => void {
    this.statusCbs.add(cb);
    return () => { this.statusCbs.delete(cb); };
  }

  onConnection(cb: (c: boolean, r?: string) => void): () => void {
    this.connectionCbs.add(cb);
    return () => { this.connectionCbs.delete(cb); };
  }

  async sendCommand(cmd: PrinterCommand): Promise<void> {
    // Bambuddy webhook control endpoints always require an API key (even when
    // bambuddy's advanced auth is disabled — webhooks are the external API).
    //   POST /api/v1/webhook/printer/{id}/pause | /resume | /stop
    const allowed: Record<string, string> = {
      pause: 'pause',
      resume: 'resume',
      cancel: 'stop',
    };
    const action = allowed[cmd.command];
    if (!action) {
      throw new Error(`command "${cmd.command}" not supported via bambuddy proxy`);
    }
    if (!this.apiKey) {
      throw new Error('bambuddy API key required for print control — create one in bambuddy → Settings → API Keys, then add it in snorcal\'s Edit Printer');
    }
    const url = `${this.baseUrl}/api/v1/webhook/printer/${this.bambuddyPrinterId}/${action}`;
    assertSafeUrl(url, { allowPrivate: true });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': this.apiKey },
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
    });
    if (!res.ok) throw new Error(`bambuddy ${action} HTTP ${res.status}`);
  }

  /**
   * Upload a sliced file to bambuddy's archive. Bambuddy stores it and
   * handles the FTP transfer to the printer at print-dispatch time (via
   * the queue). Returns the archive ID (as a string) — passed back to
   * startPrint() as the `printerPath` argument.
   *
   * OrcaSlicer/BambuStudio CLI only output raw `.gcode`; the `.gcode.3mf`
   * container (3MF zip with gcode at `Metadata/plate_N.gcode`) is a
   * GUI-only export. Bambuddy's archive upload requires `.3mf`, so raw
   * `.gcode` is wrapped into a minimal `.gcode.3mf` ZIP here first.
   * Already-`.3mf` / `.gcode.3mf` files are uploaded as-is.
   */
  async uploadFile(localPath: string, filename: string, plateNum: number = 1): Promise<string> {
    const is3mf = /\.3mf$/i.test(filename);
    let uploadBuffer: Buffer;
    let uploadFilename: string;

    if (is3mf) {
      uploadBuffer = fs.readFileSync(localPath);
      uploadFilename = filename;
    } else {
      // Raw .gcode → wrap into .gcode.3mf container.
      const wrapped = await wrapGcodeAs3mf(localPath, plateNum);
      uploadBuffer = wrapped.buffer;
      uploadFilename = wrapped.filename;
    }

    const url = `${this.baseUrl}/api/v1/archives/upload`;
    assertSafeUrl(url, { allowPrivate: true });
    const form = new FormData();
    form.append('file', new Blob([uploadBuffer], { type: 'application/octet-stream' }), uploadFilename);
    form.append('printer_id', String(this.bambuddyPrinterId));
    const res = await fetch(url, {
      method: 'POST',
      headers: this.apiKey ? { 'X-API-Key': this.apiKey } : {},
      body: form,
      signal: AbortSignal.timeout(180_000),
      redirect: 'manual',
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`bambuddy upload HTTP ${res.status} ${txt.slice(0, 200)}`);
    }
    const json = await res.json() as { id?: number };
    if (!json.id) throw new Error('bambuddy upload: no archive id in response');
    return String(json.id);
  }

  /**
   * Start a print via bambuddy's queue: create a queue item from the
   * uploaded archive, then trigger dispatch. Bambuddy handles the FTP
   * transfer + MQTT project_file command internally.
   *
   * `printerPath` is the archive ID returned by uploadFile().
   * `args.plate` is a Bambu plate-path like "Metadata/plate_1.gcode" —
   * we extract the plate number for bambuddy's plate_id field.
   * `args.amsMapping` is a number[] of tray IDs (same as direct mode).
   * `args.printOptions` maps to bambuddy's bed_levelling/flow_cali/etc.
   */
  async startPrint(printerPath: string, args?: Record<string, unknown>): Promise<void> {
    const archiveId = Number(printerPath);
    if (!Number.isInteger(archiveId) || archiveId <= 0) {
      throw new Error(`bambuddy startPrint: invalid archive id "${printerPath}"`);
    }

    // Extract plate number from "Metadata/plate_N.gcode" (1-indexed).
    let plateId: number | undefined;
    if (typeof args?.plate === 'string') {
      const m = /plate_(\d+)\.gcode/i.exec(args.plate);
      if (m) plateId = Number(m[1]);
    }

    const amsMapping = Array.isArray(args?.amsMapping) ? (args!.amsMapping as number[]) : undefined;
    const po = (args?.printOptions ?? {}) as PrintOptions;

    // Create the queue item. Bambuddy's scheduler picks it up; for immediate
    // start we also call the webhook start endpoint after.
    const queueUrl = `${this.baseUrl}/api/v1/queue/`;
    assertSafeUrl(queueUrl, { allowPrivate: true });
    const queueBody: Record<string, unknown> = {
      archive_id: archiveId,
      printer_id: this.bambuddyPrinterId,
      bed_levelling: po.bedLeveling !== false,     // bambuddy default true
      flow_cali: po.flowCali === true,
      vibration_cali: po.vibrationCali !== false,  // bambuddy default true
      timelapse: po.timelapse === true,
      use_ams: amsMapping ? amsMapping.some(v => v >= 0) : true,
      ...(amsMapping ? { ams_mapping: amsMapping } : {}),
      ...(plateId ? { plate_id: plateId } : {}),
    };
    const queueRes = await fetch(queueUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
      },
      body: JSON.stringify(queueBody),
      signal: AbortSignal.timeout(15_000),
      redirect: 'manual',
    });
    if (!queueRes.ok) {
      const txt = await queueRes.text().catch(() => '');
      throw new Error(`bambuddy queue create HTTP ${queueRes.status} ${txt.slice(0, 200)}`);
    }

    // Trigger dispatch — bambuddy clears manual_start and the scheduler
    // uploads + starts the print on the printer. The webhook endpoint
    // always requires an API key (even when bambuddy auth is disabled).
    if (!this.apiKey) {
      throw new Error('bambuddy API key required to start prints — create one in bambuddy → Settings → API Keys, then add it in snorcal\'s Edit Printer. The file was uploaded (archive ' + archiveId + ') and queued; starting it requires the key.');
    }
    const startUrl = `${this.baseUrl}/api/v1/webhook/printer/${this.bambuddyPrinterId}/start`;
    assertSafeUrl(startUrl, { allowPrivate: true });
    const startRes = await fetch(startUrl, {
      method: 'POST',
      headers: { 'X-API-Key': this.apiKey },
      signal: AbortSignal.timeout(15_000),
      redirect: 'manual',
    });
    if (!startRes.ok) {
      const txt = await startRes.text().catch(() => '');
      throw new Error(`bambuddy start HTTP ${startRes.status} ${txt.slice(0, 200)}`);
    }
  }

  cameraUrl(): string | null { return null; }

  async fetchCameraSnapshot(): Promise<Buffer | null> {
    const url = `${this.baseUrl}/api/v1/printers/${this.bambuddyPrinterId}/camera/snapshot`;
    assertSafeUrl(url, { allowPrivate: true });
    const res = await fetch(url, {
      headers: this.apiKey ? { 'X-API-Key': this.apiKey } : {},
      signal: AbortSignal.timeout(6000),
      redirect: 'manual',
    });
    if (!res.ok) throw new Error(`bambuddy camera HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopPing();
    this.stopTokenRefresh();
    if (this.ws) {
      // terminate() forces TCP RST — ws.close() is graceful and hangs in
      // CLOSE_WAIT if the peer is silent, leaking sockets over long uptime.
      try { this.ws.terminate(); } catch {}
      this.ws = null;
    }
    this.setConnection(false, 'disconnected by user');
  }
}
