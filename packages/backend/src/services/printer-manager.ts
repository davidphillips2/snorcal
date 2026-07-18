import type { Db, DbPrinter } from '../db/index.js';
import type { PrinterCommand, PrinterStatus } from '@snorcal/shared';
import type { PrinterAdapter } from './adapters/adapter.js';
import { MoonrakerAdapter } from './adapters/moonraker-adapter.js';
import { BambuAdapter } from './adapters/bambu-adapter.js';
import { BambuddyAdapter } from './adapters/bambuddy-adapter.js';
import { decryptSecret } from './secret-crypto.js';
import { emitPrinterStatus, emitPrinterConnected, emitPrinterDisconnected } from './event-bus.js';

class PrinterManager {
  private adapters = new Map<string, PrinterAdapter>();
  private db: Db | null = null;
  // Pending initial-connect retries (printerId → timer). Cleared on success
  // or explicit stop/reconnect. Without this, a printer that fails its first
  // connect (e.g. bambuddy not up yet at boot, printer offline) stays dead
  // forever — the adapters' internal reconnect only kicks in AFTER a
  // successful first connect.
  private retryTimers = new Map<string, NodeJS.Timeout>();
  private retryDelays = new Map<string, number>();
  private static readonly RETRY_DELAY_MS = 5_000;
  private static readonly RETRY_DELAY_MAX = 60_000;

  init(db: Db): void {
    this.db = db;
    // Auto-connect persisted printers
    const printers = db.listPrinters();
    for (const p of printers) {
      this.startAdapter(p).catch(err => {
        console.error(`[PrinterManager] failed to start ${p.id} (${p.name}):`, err);
      });
    }
  }

  private createAdapter(p: DbPrinter): PrinterAdapter {
    // Secrets are stored encrypted; decrypt for the adapter (transparent for
    // legacy plaintext — decryptSecret returns it unchanged if no enc: prefix).
    if (p.protocol === 'moonraker') {
      return new MoonrakerAdapter({
        printerId: p.id,
        ip: p.ip,
        port: p.port,
        apiKey: (p.api_key ? decryptSecret(p.api_key) : undefined),
        streamUrl: p.camera_stream_url ?? undefined,
        snapshotUrl: p.camera_snapshot_url ?? undefined,
      });
    }
    if (p.protocol === 'bambu') {
      // Bambuddy proxy mode: route status/control through bambuddy's HTTP/WS
      // API instead of direct MQTT. Used when bambuddy holds the printer's
      // single MQTT slot (the Bambu broker rejects concurrent clients).
      if (p.connection_mode === 'bambuddy' && p.bambuddy_url && p.bambuddy_printer_id) {
        return new BambuddyAdapter({
          printerId: p.id,
          bambuddyUrl: p.bambuddy_url,
          bambuddyPrinterId: p.bambuddy_printer_id,
          apiKey: (p.bambuddy_api_key ? decryptSecret(p.bambuddy_api_key) : undefined),
        });
      }
      return new BambuAdapter({
        printerId: p.id,
        ip: p.ip,
        port: p.port,
        serial: p.serial ?? '',
        accessCode: (p.access_code ? decryptSecret(p.access_code) : ''),
        cameraIp: p.camera_ip ?? undefined,
      });
    }
    throw new Error(`Unknown protocol: ${p.protocol}`);
  }

  async startAdapter(p: DbPrinter): Promise<void> {
    // A previous failed attempt leaves a dead adapter in the map; tear it down
    // before creating a fresh one (retry path). First-start: map is empty.
    if (this.adapters.has(p.id)) {
      const existing = this.adapters.get(p.id)!;
      try { await existing.disconnect(); } catch {}
      this.adapters.delete(p.id);
    }
    this.clearRetry(p.id);
    const adapter = this.createAdapter(p);

    adapter.onStatus((status) => {
      this.db?.updatePrinterStatus(p.id, status.state);
      emitPrinterStatus(status);
    });
    adapter.onConnection((connected, reason) => {
      if (connected) {
        this.db?.updatePrinterStatus(p.id, 'connected');
        emitPrinterConnected(p.id);
      } else {
        emitPrinterDisconnected(p.id, reason);
      }
    });

    this.adapters.set(p.id, adapter);
    try {
      await adapter.connect();
      this.retryDelays.delete(p.id); // reset backoff on success
      console.log(`[PrinterManager] connected ${p.id} (${p.protocol} ${p.ip})`);
    } catch (err) {
      console.error(`[PrinterManager] connect failed ${p.id}:`, err instanceof Error ? err.message : err);
      emitPrinterDisconnected(p.id, err instanceof Error ? err.message : String(err));
      // Schedule a retry with exponential backoff. The adapter stays in the
      // map (disconnected) so getStatus returns null, not a throw.
      this.scheduleRetry(p);
    }
  }

  /** Retry startAdapter after a backoff delay. Idempotent per printer. */
  private scheduleRetry(p: DbPrinter): void {
    if (this.retryTimers.has(p.id)) return;
    const prev = this.retryDelays.get(p.id) ?? PrinterManager.RETRY_DELAY_MS;
    const delay = Math.min(prev * 2, PrinterManager.RETRY_DELAY_MAX);
    this.retryDelays.set(p.id, delay);
    if (process.env.DEBUG_PRINTER) console.debug(`[PrinterManager] retry ${p.id} in ${delay}ms`);
    const timer = setTimeout(() => {
      this.retryTimers.delete(p.id);
      const fresh = this.db?.getPrinter(p.id);
      if (!fresh) return; // printer deleted while waiting
      this.startAdapter(fresh).catch(() => {/* scheduleRetry re-arms on failure */});
    }, delay);
    this.retryTimers.set(p.id, timer);
  }

  private clearRetry(printerId: string): void {
    const t = this.retryTimers.get(printerId);
    if (t) { clearTimeout(t); this.retryTimers.delete(printerId); }
    this.retryDelays.delete(printerId);
  }

  async stopAdapter(printerId: string): Promise<void> {
    this.clearRetry(printerId);
    const adapter = this.adapters.get(printerId);
    if (!adapter) return;
    await adapter.disconnect();
    this.adapters.delete(printerId);
  }

  /** Force-stop then start with fresh adapter (resets reconnect state). */
  async reconnect(printerId: string): Promise<void> {
    if (!this.db) throw new Error('manager not initialized');
    const p = this.db.getPrinter(printerId);
    if (!p) throw new Error(`printer ${printerId} not found`);
    await this.stopAdapter(printerId);
    await this.startAdapter(p);
  }

  getAdapter(printerId: string): PrinterAdapter | undefined {
    return this.adapters.get(printerId);
  }

  getStatus(printerId: string): PrinterStatus | null {
    return this.adapters.get(printerId)?.getStatus() ?? null;
  }

  async sendCommand(cmd: PrinterCommand): Promise<void> {
    const adapter = this.adapters.get(cmd.printerId);
    if (!adapter) throw new Error(`Printer ${cmd.printerId} not found or not connected`);
    await adapter.sendCommand(cmd);
  }

  async uploadFile(printerId: string, localPath: string, filename: string, plateNum?: number): Promise<string> {
    const adapter = this.adapters.get(printerId);
    if (!adapter) throw new Error(`Printer ${printerId} not found or not connected`);
    return adapter.uploadFile(localPath, filename, plateNum);
  }

  async startPrint(printerId: string, printerPath: string, args?: Record<string, unknown>): Promise<void> {
    const adapter = this.adapters.get(printerId);
    if (!adapter) throw new Error(`Printer ${printerId} not found or not connected`);
    await adapter.startPrint(printerPath, args);
  }
}

export const printerManager = new PrinterManager();
