import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import mqtt from 'mqtt';
import { Client as FtpClient } from 'basic-ftp';
import type { PrinterCommand, PrinterStatus, PrinterState, PrinterConnectionState, AmsSlot, PrintOptions } from '@snorcal/shared';
import type { PrinterAdapter } from './adapter.js';
import { assertSafeUrl } from '../ssrf.js';

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
  gcode_state?: string;
  stg_cur?: number;                  // print stage enum (heating/leveling/cali/etc)
  mc_print_stage?: string | number;
  gcode_file?: string;
  subtask_name?: string;
  // Print progress fields. P1S/P1P/A1 report the motion-controller percentage
  // as `mc_percent` (0-100). X1C firmware emits `print_percentage` instead.
  // Older code read a non-existent `progress` field → bar always showed 0%.
  mc_percent?: number;
  print_percentage?: number;
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
  print?: BambuPrintObject & { ams?: any };
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
  // PREPARE = printer's pre-print routine (auto bed level, nozzle check,
  // heating, flow cali). Map to 'printing' so UI shows pause/cancel controls
  // and treats it as in-progress, not idle.
  PREPARE: 'printing',
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
  // P1S only includes AMS in occasional pushall responses (not every print
  // payload). Spread-merge of lastReport loses it on those intermediate
  // ticks → UI flicker. Cache last seen AMS and reuse.
  private cachedAms: any = null;

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
        clientId: `snorcal_${this.serial}_${process.pid}`,
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
          // Mirror bambuddy connect sequence — P1S pushall response alone
          // doesn't include AMS data. get_version + extrusion_cali_get wake
          // the AMS report on the printer side.
          this.publish({ pushing: { command: 'pushall' } });
          this.publish({ info: { sequence_id: '0', command: 'get_version' } });
          this.publish({ print: { sequence_id: '0', command: 'extrusion_cali_get', filament_id: '', nozzle_diameter: '0.4' } });
          if (!settled) { settled = true; resolve(); }
          if (process.env.DEBUG_PRINTER) console.debug('[Bambu] connected + subscribed');
        });
      });

      client.on('message', (_topic, payload) => {
        const txt = payload.toString('utf-8');
        if (process.env.DEBUG_PRINTER) {
          // Log top-level keys of every message so we can find where AMS data
          // lives (pushall response splits across multiple messages; AMS may
          // arrive under a different key like ams_status or inside print).
          try {
            const obj = JSON.parse(txt);
            const keys = Object.keys(obj);
            const has_ams = 'ams' in obj;
            console.debug('[Bambu] msg keys:', keys.join(','), '| has_ams:', has_ams,
              has_ams ? `| ams.keys=${Object.keys(obj.ams ?? {}).join(',')}` : '',
              `| len=${txt.length}`);
            // Dump any non-print payload to disk for inspection (first 5 only
            // to avoid spam). The 4KB "print" pushall response on P1S does NOT
            // include AMS — bambuddy requests AMS via a separate command
            // after pushall. Capturing what arrives helps confirm.
            if (has_ams || (keys.length > 0 && !keys.includes('print'))) {
              console.debug('[Bambu] NON-PRINT MSG:', txt.slice(0, 800));
            }
          } catch { /* ignore */ }
        }
        try { this.handleReport(JSON.parse(txt)); } catch {}
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
    // Deep-merge `print` so partial P1S intermediate ticks (which omit
    // gcode_state, subtask_name, etc.) don't wipe the last pushall's values.
    // Previously shallow-merge replaced the cached print obj on every tick →
    // gcode_state was lost → fell back to top-level `state` which P1S keeps
    // at "IDLE" always → UI showed idle during active prints.
    if (report.print) {
      this.lastReport = {
        ...this.lastReport,
        print: { ...this.lastReport.print, ...report.print },
        ams: report.ams ?? this.lastReport.ams,
        info: report.info ?? this.lastReport.info,
      };
    } else {
      this.lastReport = { ...this.lastReport, ...report };
    }
    // AMS arrives intermittently (only in occasional pushall responses on P1S).
    // Cache when present so status remains stable between AMS-bearing pushes.
    const ams = report.ams ?? report.print?.ams;
    if (ams) this.cachedAms = ams;
    this.recomputeStatus();
  }

  private recomputeStatus(): void {
    const p = this.lastReport.print;
    // P1S keeps top-level `state` = "IDLE" always; real print state is in
    // `gcode_state`. Prefer gcode_state, fall back to state for older firmware.
    const stateRaw = p?.gcode_state ?? p?.state ?? 'IDLE';
    if (process.env.DEBUG_PRINTER) {
      console.debug('[Bambu] state raw:', JSON.stringify(stateRaw), 'stg_cur:', p?.stg_cur);
    }
    const state = STATE_MAP[stateRaw] ?? 'idle';

    // P1S sends AMS nested inside print.ams; X1C sends top-level ams. Cache
    // bridges the gap between AMS-bearing pushes (intermittent on P1S).
    const amsSource = this.cachedAms ?? this.lastReport.ams ?? this.lastReport.print?.ams;
    const amsSlots = this.parseAms(amsSource);

    // mc_percent is the MC-reported progress (0-100) on P1S/P1P/A1; X1C
    // firmware emits print_percentage instead. Both are percentages → /100.
    const pct = p?.mc_percent ?? p?.print_percentage;

    this.status = {
      printerId: this.printerId,
      protocol: 'bambu',
      connection: this.connection,
      state,
      progress: pct !== undefined ? pct / 100 : undefined,
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
    if (process.env.DEBUG_PRINTER) {
      console.debug('[Bambu] ams raw:', JSON.stringify(ams)?.slice(0, 600));
    }
    if (!ams || !Array.isArray(ams.ams) || ams.ams.length === 0) return undefined;
    const slots: AmsSlot[] = [];
    for (const unit of ams.ams) {
      const unitId = unit.id ?? 0;
      const trays = Array.isArray(unit.tray) ? unit.tray : [];
      for (const tray of trays) {
        if (!tray || tray.id === undefined) continue;
        // Skip empty trays. Bambu MQTT marks a loaded tray with
        // tray.tray_exist === "1". Older firmware omits the field — fall back
        // to "has spool data" via non-empty tray_type or remaining filament.
        // Without this filter, snorcal pushes 4 phantom slots per AMS unit
        // and the AMS panel renders blank for empty trays (bambuddy shows
        // only the loaded 3 the user actually has).
        const loaded = tray.tray_exist === '1'
          || (typeof tray.tray_type === 'string' && tray.tray_type.length > 0 && tray.tray_type !== 'empty')
          || (typeof tray.remain === 'number' && tray.remain > 0);
        if (!loaded) continue;
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
        // args.amsMapping = optional number[] (gcode filament idx → global tray ID; -1=skip)
        //                   When provided, switches on use_ams so printer pulls from physical trays.
        // args.printOptions = optional PrintOptions for per-print toggles (defaults: all off)
        const file = String(cmd.args?.file ?? '');
        const platePath = String(cmd.args?.plate ?? 'Metadata/plate_1.gcode');
        if (!file) throw new Error('file required for start');
        const amsMapping = Array.isArray(cmd.args?.amsMapping) ? (cmd.args!.amsMapping as number[]) : null;
        // amsMapping values are 0-indexed tray IDs (0..3 for AMS 0); -1 = skip.
        // v >= 0 = mapped to a real tray. Old `v > 0` check skipped tray 0.
        const useAms = amsMapping !== null && amsMapping.some(v => v >= 0);
        const po = (cmd.args?.printOptions ?? {}) as PrintOptions;
        // Match bambuddy wire format. P1S rejects task_id=0 (firmware clamps
        // and treats as continuation of prior failed job → "Load failed").
        // Mint a fresh id per submission, capped to signed int32 (P1S overflow).
        const submissionId = String(Date.now() % 2_147_483_647 || 1);
        this.publish({
          print: {
            sequence_id: '20000',
            command: 'project_file',
            param: platePath,
            url: `ftp://${file}`,
            file,
            md5: '',
            bed_type: 'auto',
            timelapse: po.timelapse === true,
            bed_leveling: po.bedLeveling === true,
            auto_bed_leveling: po.bedLeveling === true ? 1 : 0,
            flow_cali: po.flowCali === true,
            // 1 = run flow cali, 0 = skip. Matches BambuStudio wire format.
            extrude_cali_flag: po.flowCali === true ? 1 : 0,
            vibration_cali: po.vibrationCali === true,
            layer_inspect: false,
            use_ams: useAms,
            ...(useAms ? { ams_mapping: amsMapping } : {}),
            cfg: '0',
            subtask_name: file.replace(/\.gcode(\.3mf)?$/i, '').replace(/\.3mf$/i, ''),
            profile_id: '0',
            project_id: submissionId,
            subtask_id: submissionId,
            task_id: submissionId,
          },
        });
        return;
      }
      case 'set_ams_filament': {
        // Bambu MQTT ams_filament_setting — writes tray metadata on the printer.
        // Required: amsId (0-based AMS unit index), trayId (1-4).
        // Optional: type ('PLA'/'PETG'/...), color (8-hex FFFFFFFF), brand.
        const amsId = Number(cmd.args?.amsId);
        const trayId = Number(cmd.args?.trayId);
        if (!Number.isInteger(amsId) || !Number.isInteger(trayId)) {
          throw new Error('amsId and trayId required for set_ams_filament');
        }
        const payload: Record<string, unknown> = {
          sequence_id: '0',
          command: 'ams_filament_setting',
          ams_id: amsId,
          tray_id: trayId,
          tray_info_idx: '',     // Bambu spool catalog id (empty = custom)
          tray_type: String(cmd.args?.type ?? 'PLA'),
          tray_sub_brands: String(cmd.args?.brand ?? ''),
          tray_color: String(cmd.args?.color ?? 'FFFFFFFF'),
          nozzle_temp_min: 190,
          nozzle_temp_max: 240,
          tray_diameter: '1.75',
          setting_id: '',
          tray_uuid: '',
          ctype: 0,
        };
        this.publish({ print: payload });
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
    // Implicit FTPS on port 990, user bblp / access code.
    // allowSeparateTransferHost: bambuddy / NAT proxies advertise the real
    // printer IP in PASV replies, which differs from the control-connection
    // host. basic-ftp rejects this by default; opt in explicitly.
    const client = new FtpClient(30000, { allowSeparateTransferHost: true });
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
      // Defense-in-depth: validate the URL (allowPrivate — printer/camera is on LAN).
      assertSafeUrl(this.cameraIp, { allowPrivate: true });
      const res = await fetch(this.cameraIp, { signal: AbortSignal.timeout(6000), redirect: 'manual' });
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
