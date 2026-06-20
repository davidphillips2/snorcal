import type { PrinterCommand, PrinterStatus } from '@snorcal/shared';

/** Common adapter interface implemented by Moonraker, Bambu, Snapmaker, etc. */
export interface PrinterAdapter {
  readonly printerId: string;
  readonly protocol: 'moonraker' | 'bambu' | 'snapmaker';

  /** Establish connection. Resolves on first connect. Throws on failure. */
  connect(): Promise<void>;

  /** Disconnect and clean up. Safe to call multiple times. */
  disconnect(): Promise<void>;

  /** Current cached status (or null if not connected). */
  getStatus(): PrinterStatus | null;

  /** Subscribe to status updates. Returns unsubscribe. */
  onStatus(cb: (status: PrinterStatus) => void): () => void;

  /** Subscribe to connection state changes. */
  onConnection(cb: (connected: boolean, reason?: string) => void): () => void;

  /** Send a control command. Throws on protocol error. */
  sendCommand(cmd: PrinterCommand): Promise<void>;

  /**
   * Upload a gcode/3mf file path from disk to the printer.
   * Returns printer-side path the file landed at.
   */
  uploadFile(localPath: string, filename: string): Promise<string>;

  /**
   * Start a print for an already-uploaded file.
   * For Moonraker: path on printer filesystem.
   * For Bambu: gcode path inside 3MF + plate index in args.plateIndex.
   */
  startPrint(printerPath: string, args?: Record<string, unknown>): Promise<void>;

  /**
   * Camera stream URL (MJPEG) — null if adapter has no camera proxy.
   * Frontend hits backend route `/api/printers/:id/camera` which calls this.
   */
  cameraUrl(): string | null;

  /**
   * Optional: fetch a single JPEG snapshot. Used by camera route when a
   * snapshot URL is configured (more reliable than piping MJPEG).
   * Returns null if adapter has no snapshot fetcher.
   */
  fetchCameraSnapshot?(): Promise<Buffer | null>;
}
