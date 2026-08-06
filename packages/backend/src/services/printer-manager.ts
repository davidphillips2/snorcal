import type { Db, DbPrinter } from '../db/index.js';
import type { PrinterCommand, PrinterStatus } from '@snorcal/shared';
import type { PrinterAdapter } from './adapters/adapter.js';
import { MoonrakerAdapter } from './adapters/moonraker-adapter.js';
import { BambuAdapter } from './adapters/bambu-adapter.js';
import { BambuddyAdapter } from './adapters/bambuddy-adapter.js';
import { decryptSecret } from './secret-crypto.js';
import { eventBus, emitPrinterStatus, emitPrinterConnected, emitPrinterDisconnected } from './event-bus.js';

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
  private retryCounts = new Map<string, number>();
  private adapterStartedAt = new Map<string, number>();
  private static readonly RETRY_DELAY_MS = 5_000;
  private static readonly RETRY_DELAY_MAX = 60_000;
  /**
   * If a printer has been failing continuously for this many retries, stop
   * auto-retrying and wait for explicit user reconnect. Prevents hours-long
   * connect-fail churn that compounds memory pressure on long-running
   * processes. Adapter stays in map (disconnected); user clicks Reconnect in
   * UI which calls reconnectWithResult → startAdapter → fresh attempt.
   */
  private static readonly MAX_CONSECUTIVE_RETRIES = 30;
  /**
   * Adapters accumulate bad state over long uptime (suspected: CLOSE_WAIT
   * pile-up from graceful ws.close() on half-open sockets, libuv handle
   * leaks). After this many ms, prefer full recreate over plain reconnect
   * on the retry path so the adapter gets a clean internal slate without
   * restarting the whole backend.
   */
  private static readonly ADAPTER_ROTATE_MS = 6 * 60 * 60 * 1000; // 6h

  init(db: Db): void {
    this.db = db;
    // Auto-connect persisted printers
    const printers = db.listPrinters();
    for (const p of printers) {
      this.startAdapter(p).catch(err => {
        console.error(`[PrinterManager] failed to start ${p.id} (${p.name}):`, err);
      });
    }
    // Defensive rotation: every 1h, find adapters that are both disconnected
    // AND older than ADAPTER_ROTATE_MS, and force-recreate them. Catches the
    // "stuck disconnected after long uptime" state we've seen without waiting
    // for the user to click Reconnect.
    setInterval(() => this.rotateStaleAdapters(), 60 * 60 * 1000).unref();
  }

  private rotateStaleAdapters(): void {
    if (!this.db) return;
    for (const [printerId, adapter] of this.adapters) {
      if (!this.shouldRotateAdapter(printerId)) continue;
      const status = adapter.getStatus();
      const conn = status?.connection;
      if (conn === 'connected' || conn === 'connecting') continue; // healthy, leave alone
      const p = this.db.getPrinter(printerId);
      if (!p) continue;
      const ageMin = Math.round((Date.now() - (this.adapterStartedAt.get(printerId) ?? 0)) / 60_000);
      console.log(`[PrinterManager] rotating stale adapter ${printerId} (${p.name}, age=${ageMin}min, conn=${conn ?? 'unknown'})`);
      this.startAdapter(p).catch(err => {
        console.error(`[PrinterManager] rotate failed ${printerId}:`, err instanceof Error ? err.message : err);
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
    this.adapterStartedAt.set(p.id, Date.now());

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
      this.retryCounts.delete(p.id);
      this.networkFailures.delete(p.id);
      console.log(`[PrinterManager] connected ${p.id} (${p.protocol} ${p.ip})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[PrinterManager] connect failed ${p.id}:`, msg);
      emitPrinterDisconnected(p.id, msg);
      const count = (this.retryCounts.get(p.id) ?? 0) + 1;
      this.retryCounts.set(p.id, count);
      if (count > PrinterManager.MAX_CONSECUTIVE_RETRIES) {
        console.warn(`[PrinterManager] giving up on ${p.id} after ${count} consecutive failures — waiting for manual reconnect`);
        return; // DO NOT scheduleRetry. Adapter stays in map (disconnected).
      }
      if (/EHOSTUNREACH|ENETUNREACH|EAI_AGAIN/.test(msg)) {
        this.recordNetworkFailure(p.id);
      } else {
        this.networkFailures.delete(p.id);
      }
      this.scheduleRetry(p);
    }
  }

  /**
   * Track consecutive network-level connect failures per printer. After 5,
   * dump process.report to stdout so we have libuv/socket state for diagnosis.
   * Reset on any non-network error (likely auth/protocol, not state corruption).
   */
  private networkFailures = new Map<string, number>();
  private recordNetworkFailure(printerId: string): void {
    const n = (this.networkFailures.get(printerId) ?? 0) + 1;
    this.networkFailures.set(printerId, n);
    if (n === 5) {
      console.warn(`[PrinterManager] ${printerId} has ${n} consecutive network failures — dumping process.report`);
      try {
        const report: unknown = process.report.getReport();
        const text = typeof report === 'string' ? report : JSON.stringify(report);
        const active = (text.match(/"type":\s*"TCP"/g) ?? []).length;
        console.warn(`[PrinterManager] TCP handle markers in report: ${active}`);
        console.warn(`[PrinterManager] uptime: ${Math.round(process.uptime() / 60)}min`);
      } catch (e) {
        console.warn('[PrinterManager] process.report failed:', e instanceof Error ? e.message : e);
      }
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

  /** True if adapter has been alive longer than ADAPTER_ROTATE_MS. */
  private shouldRotateAdapter(printerId: string): boolean {
    const startedAt = this.adapterStartedAt.get(printerId);
    if (!startedAt) return false;
    return Date.now() - startedAt > PrinterManager.ADAPTER_ROTATE_MS;
  }

  async stopAdapter(printerId: string): Promise<void> {
    this.clearRetry(printerId);
    const adapter = this.adapters.get(printerId);
    if (!adapter) return;
    await adapter.disconnect();
    this.adapters.delete(printerId);
    this.adapterStartedAt.delete(printerId);
    this.networkFailures.delete(printerId);
  }

  /** Force-stop then start with fresh adapter (resets reconnect state). */
  async reconnect(printerId: string): Promise<void> {
    if (!this.db) throw new Error('manager not initialized');
    const p = this.db.getPrinter(printerId);
    if (!p) throw new Error(`printer ${printerId} not found`);
    await this.stopAdapter(printerId);
    await this.startAdapter(p);
  }

  /**
   * Stop + start fresh adapter, AND wait for the first connection event
   * (connected | disconnected) so the caller can surface a real error to the
   * user. `reconnect()` swallows connect errors via startAdapter's internal
   * try/catch + scheduleRetry — endpoint would otherwise always return ok.
   */
  async reconnectWithResult(printerId: string, timeoutMs = 6_000): Promise<{ ok: boolean; error?: string }> {
    if (!this.db) throw new Error('manager not initialized');
    const p = this.db.getPrinter(printerId);
    if (!p) throw new Error(`printer ${printerId} not found`);
    await this.stopAdapter(printerId);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: { ok: boolean; error?: string }) => {
        if (settled) return;
        settled = true;
        unsub();
        clearTimeout(timer);
        resolve(result);
      };
      const unsub = eventBus.subscribe((type, data) => {
        const d = data as { printerId?: string; reason?: string } | undefined;
        if (d?.printerId !== printerId) return;
        if (type === 'printer:connected') finish({ ok: true });
        else if (type === 'printer:disconnected') finish({ ok: false, error: d.reason || 'connection failed' });
      });
      const timer = setTimeout(() => finish({ ok: false, error: 'timed out waiting for connect' }), timeoutMs);
      this.startAdapter(p).catch(err => finish({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    });
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
