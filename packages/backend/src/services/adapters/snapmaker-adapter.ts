import fs from 'node:fs';
import path from 'node:path';
import FormData from 'form-data';
import mqtt from 'mqtt';
import type { PrinterCommand, PrinterStatus, PrinterState, PrinterConnectionState, AmsSlot } from '@snorcal/shared';
import type { PrinterAdapter } from './adapter.js';

export interface SnapmakerAdapterOptions {
  printerId: string;
  ip: string;
  port?: number;              // default 8883 (MQTTS)
  accessCode: string;         // user-entered code from printer touchscreen
  httpClient?: typeof fetch;  // injectable for tests
}

/**
 * Snapmaker hybrid HTTP + MQTTS JSON-RPC adapter.
 *
 * Lifecycle:
 *   1. connect() — plain MQTT :1883, publish server.request_key to
 *      <auth_code>/config/request, await CA/cert/key/sn/clientid
 *      in <auth_code>/config/response.
 *   2. Reconnect MQTTS :8883 with mTLS using returned credentials.
 *      Subscribe to <sn>/response, <sn>/status, <sn>/notification.
 *   3. uploadFile() — HTTP POST /server/files/upload multipart.
 *   4. startPrint() — MQTT JSON-RPC server.files.start_local_print
 *      with optional ams_mapping_info for filament remap.
 *
 * Source ref: ~/OrcaSlicer/src/slic3r/Utils/MoonRaker.cpp
 */
interface TlsBootstrapResult {
  sn: string;
  clientId: string;
  ca: string;
  cert: string;
  key: string;
  port: number;
}

interface AmsMappingEntry {
  ams: number;
  sourceColor: string;
  targetColor: string;
  filamentId: string;
  filamentType: string;
}

interface PendingRpc {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class SnapmakerAdapter implements PrinterAdapter {
  readonly printerId: string;
  readonly protocol = 'snapmaker' as const;

  private ip: string;
  private port: number;
  private accessCode: string;

  private bootstrapClient: mqtt.MqttClient | null = null;
  private tlsClient: mqtt.MqttClient | null = null;
  private tlsInfo: TlsBootstrapResult | null = null;

  private seq = 1;
  private pending = new Map<number, PendingRpc>();

  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 1000;
  private destroyed = false;

  private connection: PrinterConnectionState = 'disconnected';
  private status: PrinterStatus | null = null;

  private statusCbs = new Set<(s: PrinterStatus) => void>();
  private connectionCbs = new Set<(c: boolean, r?: string) => void>();

  constructor(opts: SnapmakerAdapterOptions) {
    this.printerId = opts.printerId;
    this.ip = opts.ip;
    this.port = opts.port ?? 8883;
    this.accessCode = opts.accessCode;
  }

  async connect(): Promise<void> {
    this.destroyed = false;
    try {
      const tlsInfo = await this.requestTlsCredentials();
      this.tlsInfo = tlsInfo;
      await this.connectMqtts(tlsInfo);
      this.reconnectDelay = 1000;
      this.setConnection(true);
    } catch (err) {
      this.setConnection(false, err instanceof Error ? err.message : String(err));
      this.scheduleReconnect();
      throw err;
    }
  }

  /**
   * Stage 1: Plain MQTT :1883, request TLS credentials via JSON-RPC.
   * Printer returns CA, client cert, private key, serial number, MQTT client ID.
   */
  private requestTlsCredentials(): Promise<TlsBootstrapResult> {
    return new Promise((resolve, reject) => {
      const bootstrapPort = 1883;
      const reqTopic = `${this.accessCode}/config/request`;
      const respTopic = `${this.accessCode}/config/response`;

      const client = mqtt.connect(`mqtt://${this.ip}:${bootstrapPort}`, {
        clientId: `snorcal-${Date.now()}`,
        keepalive: 30,
        connectTimeout: 5000,
        reconnectPeriod: 0, // no auto-reconnect during bootstrap
      });
      this.bootstrapClient = client;

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Snapmaker TLS bootstrap timeout'));
      }, 10000);

      const cleanup = () => {
        clearTimeout(timeout);
        try { client.end(true); } catch {}
        this.bootstrapClient = null;
      };

      client.on('error', (err) => {
        cleanup();
        reject(new Error(`Snapmaker bootstrap MQTT error: ${err.message}`));
      });

      client.on('connect', () => {
        client.subscribe(respTopic, (err) => {
          if (err) {
            cleanup();
            reject(new Error(`Subscribe failed: ${err.message}`));
            return;
          }
          const rpc = {
            jsonrpc: '2.0',
            method: 'server.request_key',
            params: { clientid: this.localClientHint() },
            id: this.nextSeq(),
          };
          client.publish(reqTopic, JSON.stringify(rpc), { qos: 1 });
        });
      });

      client.on('message', (_topic, payload) => {
        let msg: any;
        try { msg = JSON.parse(payload.toString()); } catch { return; }
        if (!msg.result && !msg.ca && !msg.cert) return;
        const r = msg.result ?? msg;
        if (!r.ca || !r.cert || !r.key || !r.sn) return;
        cleanup();
        resolve({
          sn: String(r.sn),
          clientId: String(r.clientid ?? this.localClientHint()),
          ca: String(r.ca),
          cert: String(r.cert),
          key: String(r.key),
          port: Number(r.port ?? 8883),
        });
      });
    });
  }

  /** Stage 2: MQTTS with mTLS, subscribe to JSON-RPC response channels. */
  private connectMqtts(info: TlsBootstrapResult): Promise<void> {
    return new Promise((resolve, reject) => {
      // Write credentials to temp files — node MQTT accepts paths OR buffers,
      // but buffers per-call require v5 options; safer to use Buffer form.
      const client = mqtt.connect(`mqtts://${this.ip}:${info.port}`, {
        clientId: info.clientId,
        keepalive: 30,
        connectTimeout: 8000,
        reconnectPeriod: 0,
        ca: Buffer.from(info.ca),
        cert: Buffer.from(info.cert),
        key: Buffer.from(info.key),
        rejectUnauthorized: false, // Snapmaker uses self-signed CA; trust the bundled CA
        protocolVersion: 5 as any,
      });
      this.tlsClient = client;

      const timeout = setTimeout(() => {
        try { client.end(true); } catch {}
        reject(new Error('Snapmaker MQTTS connect timeout'));
      }, 9000);

      client.on('connect', () => {
        clearTimeout(timeout);
        const topics = [
          `${info.sn}/response`,
          `${info.sn}/status`,
          `${info.sn}/notification`,
        ];
        client.subscribe(topics, (err) => {
          if (err) {
            reject(new Error(`MQTTS subscribe failed: ${err.message}`));
            return;
          }
          // Request initial state
          this.rpc('printer.objects.subscribe', {
            objects: {
              gcode_move: ['gcode_position', 'position', 'speed_factor'],
              extruder: ['temperature', 'target', 'power'],
              heater_bed: ['temperature', 'target', 'power'],
              toolhead: ['position', 'status'],
              virtual_sdcard: ['progress', 'is_active', 'file_position'],
              print_stats: ['state', 'filename', 'total_duration', 'print_duration', 'info'],
              display_status: ['progress', 'message'],
              fan: ['speed'],
            },
          }).catch(() => { /* non-fatal */ });
          resolve();
        });
      });

      client.on('message', (topic, payload) => this.handleMqttsMessage(topic, payload.toString()));

      client.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`MQTTS error: ${err.message}`));
      });

      client.on('close', () => {
        this.setConnection(false, 'MQTTS closed');
        this.scheduleReconnect();
      });

      client.on('offline', () => {
        this.setConnection(false, 'MQTTS offline');
      });
    });
  }

  private handleMqttsMessage(topic: string, raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (process.env.DEBUG_PRINTER) console.debug('[Snapmaker]', topic, raw.slice(0, 200));

    // JSON-RPC response — correlate to pending request by id
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'JSON-RPC error'));
        else p.resolve(msg.result);
      }
      return;
    }

    // Status push
    if (msg.method === 'notify_status_update' && msg.params) {
      this.mergeStatus(msg.params);
    } else if (msg.method === 'notify_klippy_ready' || msg.method === 'notify_klippy_shutdown') {
      // Klipper state events — refresh
    }
  }

  private mergeStatus(patch: any): void {
    // Reuse Moonraker-shaped object model
    if (!this.status) {
      this.status = {
        printerId: this.printerId,
        protocol: 'snapmaker',
        connection: this.connection,
        state: 'idle',
        updatedAt: new Date().toISOString(),
      };
    }
    const ps = patch.print_stats ?? patch;
    if (ps.state) {
      const stateMap: Record<string, PrinterState> = {
        standby: 'idle', idle: 'idle', printing: 'printing',
        paused: 'paused', complete: 'complete', cancelled: 'idle', error: 'error',
      };
      this.status.state = stateMap[ps.state] ?? 'idle';
    }
    if (ps.filename !== undefined) this.status.file = ps.filename;
    if (ps.info?.current_layer !== undefined) this.status.layer = ps.info.current_layer;
    if (ps.info?.total_layer !== undefined) this.status.totalLayers = ps.info.total_layer;
    if (patch.virtual_sdcard?.progress !== undefined) this.status.progress = patch.virtual_sdcard.progress;
    if (patch.display_status?.progress !== undefined) this.status.progress = patch.display_status.progress;
    if (patch.extruder?.temperature !== undefined) {
      this.status.temps = { ...this.status.temps, hotend: patch.extruder.temperature, hotendTarget: patch.extruder.target };
    }
    if (patch.heater_bed?.temperature !== undefined) {
      this.status.temps = { ...this.status.temps, bed: patch.heater_bed.temperature, bedTarget: patch.heater_bed.target };
    }
    if (patch.fan?.speed !== undefined) this.status.fanSpeed = Math.round(patch.fan.speed * 100);
    this.status.updatedAt = new Date().toISOString();
    this.emitStatus();
  }

  /** Send JSON-RPC request via MQTTS publish to <sn>/request. */
  private rpc(method: string, params?: Record<string, unknown>): Promise<any> {
    if (!this.tlsClient || !this.tlsInfo) {
      return Promise.reject(new Error('Snapmaker not connected'));
    }
    const id = this.nextSeq();
    const reqTopic = `${this.tlsInfo.sn}/request`;
    const payload = { jsonrpc: '2.0', method, params: params ?? {}, id };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Snapmaker RPC timeout: ${method}`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.tlsClient!.publish(reqTopic, JSON.stringify(payload), { qos: 1 }, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`MQTT publish failed: ${err.message}`));
        }
      });
    });
  }

  private nextSeq(): number {
    return this.seq++;
  }

  private localClientHint(): string {
    // Server returns authoritative clientid; we send a hint based on local IP.
    return `snorcal-${this.printerId}-${Date.now()}`;
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
      this.connect().catch(() => { /* will reschedule */ });
    }, this.reconnectDelay);
  }

  async disconnect(): Promise<void> {
    this.destroyed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('disconnecting'));
    }
    this.pending.clear();
    if (this.tlsClient) { try { this.tlsClient.end(true); } catch {} this.tlsClient = null; }
    if (this.bootstrapClient) { try { this.bootstrapClient.end(true); } catch {} this.bootstrapClient = null; }
    this.setConnection(false, 'disconnected by user');
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
    switch (cmd.command) {
      case 'pause':  await this.rpc('printer.print.pause'); return;
      case 'resume': await this.rpc('printer.print.resume'); return;
      case 'cancel': await this.rpc('printer.print.cancel'); return;
      case 'home': {
        const axes = (cmd.args?.axes as string[]) ?? ['x', 'y', 'z'];
        await this.rpc('printer.gcode.script', { script: 'G28 ' + axes.map(a => a.toUpperCase()).join(' ') });
        return;
      }
      case 'jog': {
        const axis = String(cmd.args?.axis).toUpperCase();
        const amount = Number(cmd.args?.amount);
        await this.rpc('printer.gcode.script', { script: `G1 ${axis}${amount} F6000` });
        return;
      }
      case 'set_temp': {
        const heater = String(cmd.args?.heater);
        const value = Number(cmd.args?.value);
        const g = heater === 'bed' ? `M140 S${value}` : `M104 S${value}`;
        if (heater === 'bed') await this.rpc('printer.control.bed_temp', { target: value });
        else await this.rpc('printer.control.extruder_temp', { target: value });
        // Also send raw gcode in case control methods differ across firmware
        await this.rpc('printer.gcode.script', { script: g });
        return;
      }
      case 'send_gcode':
        await this.rpc('printer.gcode.script', { script: String(cmd.args?.script) });
        return;
      case 'start': {
        const file = String(cmd.args?.file ?? '');
        if (!file) throw new Error('file required for start');
        const params: Record<string, unknown> = { type: 'local', path: file };
        // amsMapping: number[] where index = gcode filament idx, value = 1-indexed AMS tray (0=skip)
        // Convert to ams_mapping_info format expected by Snapmaker
        if (Array.isArray(cmd.args?.amsMapping)) {
          params.ams_mapping_info = this.buildAmsMappingInfo(cmd.args!.amsMapping as number[]);
        }
        await this.rpc('server.files.start_local_print', params);
        return;
      }
      case 'set_ams_filament': {
        // Snapmaker JSON-RPC: printer.ams.set_filament
        // Per-tray write — same shape conceptually as Bambu's ams_filament_setting.
        const amsId = Number(cmd.args?.amsId);
        const trayId = Number(cmd.args?.trayId);
        if (!Number.isInteger(amsId) || !Number.isInteger(trayId)) {
          throw new Error('amsId and trayId required for set_ams_filament');
        }
        await this.rpc('printer.ams.set_filament', {
          ams_id: amsId,
          tray_id: trayId,
          type: String(cmd.args?.type ?? 'PLA'),
          color: String(cmd.args?.color ?? 'FFFFFFFF'),
          brand: String(cmd.args?.brand ?? ''),
        });
        return;
      }
      default: throw new Error(`Unsupported command: ${cmd.command}`);
    }
  }

  /**
   * Convert simple [trayIdx...] mapping to Snapmaker's ams_mapping_info format.
   * Input: mapping[i] = 1-indexed tray number (0=skip)
   * Output: [{ams, sourceColor, targetColor, filamentId, filamentType}, ...]
   *
   * Snapmaker firmware is permissive — sourceColor/targetColor can be empty
   * strings when caller has no color info. filamentId can be empty too.
   */
  private buildAmsMappingInfo(mapping: number[]): AmsMappingEntry[] {
    return mapping.map((tray, i) => ({
      ams: tray > 0 ? tray : 0,
      sourceColor: '',
      targetColor: '',
      filamentId: '',
      filamentType: '',
    }));
  }

  async uploadFile(localPath: string, filename: string): Promise<string> {
    const stats = fs.statSync(localPath);
    const stream = fs.createReadStream(localPath);
    const form = new FormData();
    form.append('file', stream as any, { filename, knownLength: stats.size });
    form.append('root', 'gcodes');
    form.append('path', '/');

    const url = `http://${this.ip}:8080/server/files/upload`;
    const res = await fetch(url, {
      method: 'POST',
      headers: form.getHeaders(),
      body: form as any,
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Snapmaker upload failed: HTTP ${res.status} ${txt}`);
    }
    const json = await res.json() as any;
    return json.result?.item?.path || filename;
  }

  async startPrint(printerPath: string, args?: Record<string, unknown>): Promise<void> {
    await this.sendCommand({
      printerId: this.printerId,
      command: 'start',
      args: { file: printerPath, ...(args ?? {}) },
    });
  }

  cameraUrl(): string | null {
    // Snapmaker camera access via JSON-RPC camera.start_monitor — backend route proxies
    return null;
  }

  async fetchCameraSnapshot(): Promise<Buffer | null> {
    try {
      const result = await this.rpc('camera.get_timelapse_instance', {});
      // Snapshot endpoint not standardized — return null for now, frontend shows no camera
      return null;
    } catch { return null; }
  }
}
