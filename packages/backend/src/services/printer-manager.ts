import type { Db, DbPrinter } from '../db/index.js';
import type { PrinterCommand, PrinterStatus } from '@snorcal/shared';
import type { PrinterAdapter } from './adapters/adapter.js';
import { MoonrakerAdapter } from './adapters/moonraker-adapter.js';
import { BambuAdapter } from './adapters/bambu-adapter.js';
import { emitPrinterStatus, emitPrinterConnected, emitPrinterDisconnected } from './event-bus.js';

class PrinterManager {
  private adapters = new Map<string, PrinterAdapter>();
  private db: Db | null = null;

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
    if (p.protocol === 'moonraker') {
      return new MoonrakerAdapter({
        printerId: p.id,
        ip: p.ip,
        port: p.port,
        apiKey: p.api_key ?? undefined,
        streamUrl: p.camera_stream_url ?? undefined,
        snapshotUrl: p.camera_snapshot_url ?? undefined,
      });
    }
    if (p.protocol === 'bambu') {
      return new BambuAdapter({
        printerId: p.id,
        ip: p.ip,
        port: p.port,
        serial: p.serial ?? '',
        accessCode: p.access_code ?? '',
        cameraIp: p.camera_ip ?? undefined,
      });
    }
    throw new Error(`Unknown protocol: ${p.protocol}`);
  }

  async startAdapter(p: DbPrinter): Promise<void> {
    if (this.adapters.has(p.id)) return;
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
      console.log(`[PrinterManager] connected ${p.id} (${p.protocol} ${p.ip})`);
    } catch (err) {
      console.error(`[PrinterManager] connect failed ${p.id}:`, err instanceof Error ? err.message : err);
      // Leave adapter in map for retry; surface error via event
      emitPrinterDisconnected(p.id, err instanceof Error ? err.message : String(err));
    }
  }

  async stopAdapter(printerId: string): Promise<void> {
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

  async uploadFile(printerId: string, localPath: string, filename: string): Promise<string> {
    const adapter = this.adapters.get(printerId);
    if (!adapter) throw new Error(`Printer ${printerId} not found or not connected`);
    return adapter.uploadFile(localPath, filename);
  }

  async startPrint(printerId: string, printerPath: string, args?: Record<string, unknown>): Promise<void> {
    const adapter = this.adapters.get(printerId);
    if (!adapter) throw new Error(`Printer ${printerId} not found or not connected`);
    await adapter.startPrint(printerPath, args);
  }
}

export const printerManager = new PrinterManager();
