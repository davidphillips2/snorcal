export interface DiscoveredDevice {
  ip: string;
  port: number;
  location: string;
  friendlyName: string;
  server: string;
  st: string;
  usn: string;
}

/** Persisted printer record (DB row). */
export interface PrinterRecord {
  id: string;
  name: string;
  protocol: PrinterProtocol;
  ip: string;
  port: number;
  serial?: string | null;
  accessCode?: string | null;
  apiKey?: string | null;
  cameraStreamUrl?: string | null;
  cameraSnapshotUrl?: string | null;
  model?: string | null;
  manualSlots?: number;
  bedVolume?: { x: number; y: number; z: number } | null;
  status?: PrinterStatus | null;
  lastStatus?: string | null;
  lastSeen?: string | null;
  createdAt: string;
}

export type PrinterProtocol = 'moonraker' | 'bambu';

export type PrinterConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export type PrinterState =
  | 'idle'
  | 'printing'
  | 'paused'
  | 'complete'
  | 'error'
  | 'offline';

export interface AmsSlot {
  id: number;
  trayId: number;
  type?: string;       // 'PLA', 'PETG', ...
  color?: string;      // hex without '#', e.g. 'FFFF00AA'
  brand?: string;
  remain?: number;     // 0-100
}

export interface PrinterTemps {
  bed?: number;        // current °C
  bedTarget?: number;
  hotend?: number;          // primary hotend (kept for backwards compat)
  hotendTarget?: number;
  /** All hotends (multi-toolhead printers like Snapmaker U1). index 0 = primary. */
  hotends?: { current?: number; target?: number }[];
}

/** Normalized live status from either adapter. */
export interface PrinterStatus {
  printerId: string;
  protocol: PrinterProtocol;
  connection: PrinterConnectionState;
  state: PrinterState;
  progress?: number;          // 0-1
  layer?: number;
  totalLayers?: number;
  temps?: PrinterTemps;
  fanSpeed?: number;          // 0-100 (% of max)
  etaSec?: number;
  file?: string;              // current print filename
  ams?: AmsSlot[];
  message?: string;           // human-readable error/info
  updatedAt: string;          // ISO timestamp
}

export interface PrintOptions {
  timelapse?: boolean;
  bedLeveling?: boolean;
  flowCali?: boolean;       // bambu only
  vibrationCali?: boolean;  // bambu only
}

export type PrinterCommandName =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'start'           // args.file = path on printer, args.printOptions?: PrintOptions
  | 'set_temp'        // args.heater ('bed'|'hotend'), args.value
  | 'jog'             // args.axis ('x'|'y'|'z'), args.amount
  | 'home'            // args.axes?: string[]
  | 'send_gcode'      // args.script
  | 'set_ams_filament'; // args.amsId, args.trayId, args.type?, args.color?, args.brand?

export interface PrinterCommand {
  printerId: string;
  command: PrinterCommandName;
  args?: Record<string, unknown>;
}

/** Send gcode file to printer (unified across protocols). */
export interface PrinterSendRequest {
  jobId: string;
  printerId: string;
  startPrint?: boolean;
}
