import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import mqtt from 'mqtt';
import { Client as FtpClient } from 'basic-ftp';
import type { PrinterCommand, PrinterStatus, PrinterState, PrinterConnectionState, AmsSlot } from '@slorca/shared';
import type { PrinterAdapter } from './adapter.js';

export interface BambuAdapterOptions {
  printerId: string;
  ip: string;
  port?: number;            // default 8883 (MQTT/TLS)
  serial: string;           // printer serial number
  accessCode: string;       // 8-digit LAN access code
  cameraPort?: number;      // default 6000 (P1 snapshot binary)
  cameraIp?: string;        // override host for camera fetches (default: ip)
}

interface BambuPrintObject {
  // Subset of fields actually used
  state?: string;
  gcode_file?: string;
  subtask_name?: string;
  progress?: number;
  layer_num?: number;
  total_layer_num?: number;
  mc_remaining_time?: number;       // minutes
  bed_temper?: number;
  nozzle_temper?: number;
  bed_target_temper?: number;
  nozzle_target_temper?: number;
  cooling_fan_speed?: number;        // 0-100 percent
  big_fan1_speed?: number;           // chamber fan
  spd_lvl?: number;
  ams_status?: number;
  // Plus AMS info comes on top-level `ams` key, handled separately
}

interface BambuReport {
  print?: BambuPrintObject;
  ams?: any;
  info?: { module?: { project_name?: string } };
}

const STATE_MAP: Record<string, PrinterState> = {
  RUNNING: 'printing',
  PAUSE: 'paused',
  PAUSED: 'paused',
  IDLE: 'idle',
  FINISH: 'complete',
  FAILED: 'error',
  SLICING: 'idle',
  PREPARE: 'idle',
};

export class BambuAdapter implements PrinterAdapter {
  readonly printerId: string;
  readonly protocol = 'bambu' as const;

  private ip: string;
  private port: number;
  private serial: string;
  private accessCode: string;
  private cameraPort: number;
  private cameraIp: string;

  private client: mqtt.MqttClient | null = null;
  private connection: PrinterConnectionState = 'disconnected';
  private status: PrinterStatus | null = null;
  private lastReport: BambuReport = {};

  private statusCbs = new Set<(s: PrinterStatus) => void>();
  private connectionCbs = new Set<(c: boolean, r?: string) => void>();

  constructor(opts: BambuAdapterOptions) {
    this.printerId = opts.printerId;
    this.ip = opts.ip;
    this.port = opts.port ?? 8883;
    this.serial = opts.serial;
    this.accessCode = opts.accessCode;
    this.cameraPort = opts.cameraPort ?? 6000;
    this.cameraIp = opts.cameraIp ?? opts.ip;
  }

  async connect(): Promise<void> {
    // Tear down any previous client first
    if (this.client) {
      try { await this.client.endAsync(true); } catch {}
      this.client = null;
    }

    return new Promise((resolve, reject) => {
      const brokerUrl = `mqtts://${this.ip}:${this.port}`;
      const client = mqtt.connect(brokerUrl, {
        clientId: `slorca_${this.serial}_${process.pid}`,
        username: 'bblp',
        password: this.accessCode,
        protocolVersion: 4,             // MQTT 3.1.1
        keepalive: 30,
        reconnectPeriod: 30000,         // gentle — bambuddy proxy bans >5 attempts/60s
        connectTimeout: 8000,
        rejectUnauthorized: false,
        ...({ checkServerIdentity: () => undefined } as any),
      });

      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        this.setConnection(false, err.message);
        if (process.env.DEBUG_PRINTER) console.debug('[Bambu] connect reject:', err.message);
        reject(err);
      };

      client.on('connect', () => {
        const topic = `device/${this.serial}/report`;
        client.subscribe(topic, { qos: 1 }, (err) => {
          if (err) { fail(err); return; }
          this.client = client;
          this.setConnection(true);
          this.publish({ pushing: { command: 'pushall', sequence_id: '0' } });
          if (!settled) { settled = true; resolve(); }
          if (process.env.DEBUG_PRINTER) console.debug('[Bambu] connected + subscribed');
        });
      });

      client.on('message', (_topic, payload) => {
        try { this.handleReport(JSON.parse(payload.toString('utf-8'))); } catch {}
      });

      client.on('error', (err) => {
        if (process.env.DEBUG_PRINTER) console.debug('[Bambu] mqtt error:', err.message);
        if (!settled) fail(err);
      });

      client.on('close', () => {
        if (process.env.DEBUG_PRINTER) console.debug('[Bambu] close');
        this.setConnection(false, 'mqtt closed');
        if (!settled) { settled = true; reject(new Error('mqtt closed')); return; }
      });

      client.on('offline', () => {
        if (process.env.DEBUG_PRINTER) console.debug('[Bambu] offline');
        this.setConnection(false, 'mqtt offline');
      });

      client.on('reconnect', () => {
        if (process.env.DEBUG_PRINTER) console.debug('[Bambu] reconnecting...');
      });

      setTimeout(() => { if (!settled) fail(new Error('connect timeout')); }, 6000);
    });
  }

  private publish(payload: unknown): void {
    if (!this.client) return;
    const topic = `device/${this.serial}/request`;
    this.client.publish(topic, JSON.stringify(payload), { qos: 1 });
  }

  private handleReport(report: BambuReport): void {
    this.lastReport = { ...this.lastReport, ...report };
    this.recomputeStatus();
  }

  private recomputeStatus(): void {
    const p = this.lastReport.print;
    const stateRaw = p?.state ?? 'IDLE';
    const state = STATE_MAP[stateRaw] ?? 'idle';

    const amsSlots = this.parseAms(this.lastReport.ams);

    this.status = {
      printerId: this.printerId,
      protocol: 'bambu',
      connection: this.connection,
      state,
      progress: p?.progress !== undefined ? p.progress / 100 : undefined,
      layer: p?.layer_num,
      totalLayers: p?.total_layer_num,
      temps: {
        bed: p?.bed_temper,
        bedTarget: p?.bed_target_temper,
        hotend: p?.nozzle_temper,
        hotendTarget: p?.nozzle_target_temper,
      },
      fanSpeed: p?.cooling_fan_speed,
      etaSec: p?.mc_remaining_time !== undefined ? p.mc_remaining_time * 60 : undefined,
      file: p?.subtask_name ?? p?.gcode_file,
      ams: amsSlots,
      updatedAt: new Date().toISOString(),
    };
    this.emitStatus();
  }

  private parseAms(ams: any): AmsSlot[] | undefined {
    if (!ams || !Array.isArray(ams.ams) || ams.ams.length === 0) return undefined;
    const slots: AmsSlot[] = [];
    for (const unit of ams.ams) {
      const unitId = unit.id ?? 0;
      const trays = Array.isArray(unit.tray) ? unit.tray : [];
      for (const tray of trays) {
        if (!tray || tray.id === undefined) continue;
        slots.push({
          id: unitId,
          trayId: tray.id,
          type: tray.tray_type,
          color: tray.tray_color,
          brand: tray.tray_sub_brands,
          remain: tray.remain,
        });
      }
    }
    return slots.length ? slots : undefined;
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

  async disconnect(): Promise<void> {
    if (this.client) {
      try { await this.client.endAsync(); } catch {}
      this.client = null;
    }
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
      case 'pause':   this.publish({ print: { sequence_id: '0', command: 'pause' } }); return;
      case 'resume':  this.publish({ print: { sequence_id: '0', command: 'resume' } }); return;
      case 'cancel':  this.publish({ print: { sequence_id: '0', command: 'stop' } }); return;
      case 'set_temp': {
        const heater = String(cmd.args?.heater);
        const value = Number(cmd.args?.value);
        if (heater === 'bed') {
          this.publish({ print: { sequence_id: '0', command: 'bed_target', target: value } });
        } else {
          this.publish({ print: { sequence_id: '0', command: 'nozzle_target', target: value } });
        }
        return;
      }
      case 'send_gcode': {
        const lines = String(cmd.args?.script).split('\n').filter(Boolean);
        for (const line of lines) {
          this.publish({ print: { sequence_id: '0', command: 'gcode_line', param: line } });
        }
        this.publish({ print: { sequence_id: '0', command: 'gcode_end' } });
        return;
      }
      case 'start': {
        // args.file = printer-side 3mf filename (already FTP'd)
        // args.plate = gcode path inside 3mf e.g. "Metadata/plate_1.gcode"
        const file = String(cmd.args?.file ?? '');
        const platePath = String(cmd.args?.plate ?? 'Metadata/plate_1.gcode');
        if (!file) throw new Error('file required for start');
        this.publish({
          print: {
            sequence_id: '0',
            command: 'project_file',
            param: platePath,
            url: `ftp://${file}`,
            file,
            md5: '',
            bed_type: 'auto',
            timelapse: false,
            bed_leveling: true,
            flow_cali: false,
            vibration_cali: true,
            layer_inspect: false,
            use_ams: false,
            cfg: '0',
          },
        });
        return;
      }
      case 'jog':
      case 'home':
        throw new Error(`${cmd.command} requires manual mode — Bambu does not support remote jog`);
      default:
        throw new Error(`Unsupported command: ${cmd.command}`);
    }
  }

  async uploadFile(localPath: string, filename: string): Promise<string> {
    // Implicit FTPS on port 990, user bblp / access code
    const client = new FtpClient(30000);
    try {
      await client.access({
        host: this.ip,
        port: 990,
        user: 'bblp',
        password: this.accessCode,
        secure: 'implicit',
        secureOptions: { rejectUnauthorized: false },
      });
      await client.uploadFrom(localPath, `/${filename}`);
      return filename;
    } finally {
      client.close();
    }
  }

  async startPrint(printerPath: string, args?: Record<string, unknown>): Promise<void> {
    await this.sendCommand({
      printerId: this.printerId,
      command: 'start',
      args: { file: printerPath, ...(args ?? {}) },
    });
  }

  cameraUrl(): string | null {
    // Backend route `/api/printers/:id/camera` handles snapshot fetching
    // (Bambu P1 custom binary protocol — direct browser can't speak it)
    return null;
  }

  /**
   * Fetch a JPEG snapshot. Two paths:
   *  - HTTP URL override (e.g. bambuddy proxy): simple GET, return buffer
   *  - Default: Bambu chamber-image binary protocol on port 6000
   */
  async fetchCameraSnapshot(): Promise<Buffer | null> {
    // HTTP override — camera_ip may hold a full URL (e.g. bambuddy snapshot endpoint)
    if (/^https?:\/\//i.test(this.cameraIp)) {
      const res = await fetch(this.cameraIp, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`camera HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    }

    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: this.cameraIp,
        port: this.cameraPort,
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
      }, () => {
        // 80-byte auth payload — layout matches Bambu chamber-image protocol
        // 0-3: 0x40 magic | 4-7: 0x3000 cmd | 8-15: padding
        // 16-47: "bblp" + nulls (32-byte slot) | 48-79: access code + nulls (32-byte slot)
        const buf = Buffer.alloc(80, 0);
        buf.writeUInt32LE(0x40, 0);
        buf.writeUInt32LE(0x3000, 4);
        buf.write('bblp', 16, 'ascii');
        buf.write(this.accessCode, 48, 'ascii');
        socket.write(buf);
      });

      // Response framing: 16-byte header (LE uint32 at offset 0 = payload size) + JPEG bytes
      let payloadSize = -1;
      let buffered = Buffer.alloc(0);
      let resolved = false;
      const finish = (err?: Error) => {
        if (resolved) return;
        resolved = true;
        socket.destroy();
        if (err) { reject(err); return; }
        if (payloadSize <= 0 || buffered.length < payloadSize) {
          reject(new Error('camera frame incomplete'));
          return;
        }
        resolve(buffered.subarray(0, payloadSize));
      };

      socket.on('data', (data: Buffer) => {
        buffered = Buffer.concat([buffered, data]);
        if (payloadSize < 0 && buffered.length >= 16) {
          payloadSize = buffered.readUInt32LE(0);
          if (payloadSize === 0 || payloadSize > 10_000_000) {
            return finish(new Error(`invalid payload size ${payloadSize}`));
          }
          buffered = buffered.subarray(16);
        }
        if (payloadSize > 0 && buffered.length >= payloadSize) {
          finish();
        }
      });

      socket.on('end', () => finish());
      socket.on('error', (err) => finish(err));

      setTimeout(() => finish(new Error('camera timeout')), 4000);
    });
  }
}
