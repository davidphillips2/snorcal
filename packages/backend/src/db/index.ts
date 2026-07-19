import Database from 'better-sqlite3';
import { MIGRATIONS, runSchemaMigrations } from './migrations.js';
import { seedDefaultProfiles } from './seed-profiles.js';
import { encryptSecret, isEncrypted } from '../services/secret-crypto.js';

/** Encrypt a secret for storage unless it's empty or already encrypted. */
function enc(v: string | null | undefined): string | null {
  if (v == null || v === '') return null;
  return isEncrypted(v) ? v : encryptSecret(v);
}

export class Db {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.encryptLegacySecrets();
  }

  /**
   * One-shot migration: re-encrypt any plaintext secrets already in the DB.
   * Idempotent — rows already carrying the `enc:v1:` prefix are skipped.
   * Runs on every startup; cheap when there's nothing to do (a few SELECTs).
   */
  private encryptLegacySecrets() {
    let migrated = 0;
    const cols: Array<{ table: string; col: string; where?: string }> = [
      { table: 'printers', col: 'access_code' },
      { table: 'printers', col: 'api_key' },
      { table: 'printers', col: 'bambuddy_api_key' },
      { table: 'app_settings', col: 'value', where: "key = 'bambu_cloud_token'" },
    ];
    for (const { table, col, where } of cols) {
      const sql = `SELECT id AS pk, ${col} AS v FROM ${table}${where ? ` WHERE ${where}` : ''}`;
      let rows: any[];
      try {
        rows = this.db.prepare(sql).all() as any[];
      } catch {
        // Table/column may not exist on a fresh DB mid-migration; skip silently.
        continue;
      }
      for (const row of rows) {
        if (typeof row.v !== 'string' || row.v === '' || isEncrypted(row.v)) continue;
        // Encrypt + write back. `enc` skips already-encrypted values; safe.
        const upd = this.db.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`);
        upd.run(enc(row.v), row.pk);
        migrated++;
      }
    }
    if (migrated > 0) {
      console.log(`[db] encrypted ${migrated} legacy plaintext secret(s) at rest.`);
    }
  }

  private migrate() {
    for (const sql of MIGRATIONS) {
      this.db.exec(sql);
    }
    runSchemaMigrations(this.db);
    seedDefaultProfiles(this);
  }

  // --- Models ---

  insertModel(model: {
    id: string; name: string; filePath: string; fileSize: number;
    format: string; faceCount: number; boundsX: number; boundsY: number; boundsZ: number;
    plateCount?: number;
    boundsMinX?: number; boundsMinY?: number; boundsMinZ?: number;
    boundsMaxX?: number; boundsMaxY?: number; boundsMaxZ?: number;
  }) {
    this.db.prepare(`
      INSERT INTO models (id, name, file_path, file_size, format, face_count, bounds_x, bounds_y, bounds_z, plate_count,
        bounds_min_x, bounds_min_y, bounds_min_z, bounds_max_x, bounds_max_y, bounds_max_z)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(model.id, model.name, model.filePath, model.fileSize, model.format,
      model.faceCount, model.boundsX, model.boundsY, model.boundsZ, model.plateCount ?? 1,
      model.boundsMinX ?? null, model.boundsMinY ?? null, model.boundsMinZ ?? null,
      model.boundsMaxX ?? null, model.boundsMaxY ?? null, model.boundsMaxZ ?? null);
  }

  getModel(id: string) {
    return this.db.prepare('SELECT * FROM models WHERE id = ?').get(id) as DbModel | undefined;
  }

  listModels() {
    return this.db.prepare('SELECT id, name, format, face_count, file_size, plate_count, created_at FROM models ORDER BY created_at DESC').all() as DbModelSummary[];
  }

  updateModelColors(id: string, colors: Buffer) {
    this.db.prepare('UPDATE models SET face_colors = ? WHERE id = ?').run(colors, id);
  }

  deleteModel(id: string) {
    this.db.prepare('DELETE FROM models WHERE id = ?').run(id);
  }

  // --- Jobs ---

  insertJob(job: {
    id: string; modelId: string; engine: string; settings: string; outputDir: string;
    printerId?: string | null; printerName?: string | null;
  }) {
    this.db.prepare(`
      INSERT INTO jobs (id, model_id, engine, settings, output_dir, printer_id, printer_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(job.id, job.modelId, job.engine, job.settings, job.outputDir, job.printerId ?? null, job.printerName ?? null);
  }

  getJob(id: string) {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as DbJob | undefined;
  }

  listJobs(status?: string) {
    if (status) {
      return this.db.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC').all(status) as DbJob[];
    }
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as DbJob[];
  }

  /**
   * Jobs older than `days` days, optionally filtered by status set.
   * Pass days=0 to skip the age filter. Empty/missing statuses = all statuses.
   * Used by the storage cleanup route.
   */
  listJobsOlderThan(days: number, statuses?: string[]): DbJob[] {
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (days > 0) {
      conds.push("created_at < datetime('now', ?)");
      params.push(`-${days} days`);
    }
    if (statuses && statuses.length > 0) {
      const placeholders = statuses.map(() => '?').join(',');
      conds.push(`status IN (${placeholders})`);
      params.push(...statuses);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC`).all(...params) as DbJob[];
  }

  /** All jobs belonging to a model (any status). Used to fs-clean their workDirs when the model is purged. */
  listJobsByModel(modelId: string): DbJob[] {
    return this.db.prepare('SELECT * FROM jobs WHERE model_id = ?').all(modelId) as DbJob[];
  }

  /**
   * Models with no jobs in the last `days` days. Pass days=0 to mean "no jobs
   * at all" (truly orphaned). Used by the storage cleanup route.
   */
  listOrphanedModels(days: number): DbModel[] {
    if (days > 0) {
      return this.db.prepare(`
        SELECT m.* FROM models m
        WHERE NOT EXISTS (
          SELECT 1 FROM jobs j
          WHERE j.model_id = m.id AND j.created_at >= datetime('now', ?)
        )
        ORDER BY m.created_at DESC
      `).all(`-${days} days`) as DbModel[];
    }
    return this.db.prepare(`
      SELECT m.* FROM models m
      WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.model_id = m.id)
      ORDER BY m.created_at DESC
    `).all() as DbModel[];
  }

  /** Models older than `days` days. days=0 returns all. */
  listModelsOlderThan(days: number): DbModel[] {
    if (days > 0) {
      return this.db.prepare("SELECT * FROM models WHERE created_at < datetime('now', ?) ORDER BY created_at DESC")
        .all(`-${days} days`) as DbModel[];
    }
    return this.db.prepare('SELECT * FROM models ORDER BY created_at DESC').all() as DbModel[];
  }

  /** Delete one job row by id. Does NOT touch disk — caller handles fs cleanup. */
  deleteJob(id: string) {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  }

  updateJobStatus(id: string, status: string, extra?: { progress?: number; currentStep?: string; errorMessage?: string }) {
    if (status === 'running') {
      this.db.prepare('UPDATE jobs SET status = ?, progress = ?, started_at = datetime(\'now\') WHERE id = ?')
        .run(status, extra?.progress ?? 0, id);
    } else if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      this.db.prepare('UPDATE jobs SET status = ?, progress = ?, completed_at = datetime(\'now\'), error_message = ? WHERE id = ?')
        .run(status, extra?.progress ?? (status === 'completed' ? 100 : 0), extra?.errorMessage ?? null, id);
    } else {
      this.db.prepare('UPDATE jobs SET status = ?, progress = ?, current_step = ? WHERE id = ?')
        .run(status, extra?.progress ?? 0, extra?.currentStep ?? null, id);
    }
  }

  updateJobProgress(id: string, progress: number, currentStep?: string) {
    this.db.prepare('UPDATE jobs SET progress = ?, current_step = ? WHERE id = ?')
      .run(progress, currentStep ?? null, id);
  }

  updateJobOutput(id: string, gcodeSize: number) {
    this.db.prepare('UPDATE jobs SET gcode_size = ? WHERE id = ?').run(gcodeSize, id);
  }

  updateJobEstimates(id: string, estimates: { modelName?: string; estimatedTime?: string; filamentUsedG?: number; filamentCost?: number }) {
    this.db.prepare(`UPDATE jobs SET model_name = ?, estimated_time = ?, filament_used_g = ?, filament_cost = ? WHERE id = ?`)
      .run(estimates.modelName ?? null, estimates.estimatedTime ?? null, estimates.filamentUsedG ?? null, estimates.filamentCost ?? null, id);
  }

  // --- Profiles ---

  listProfiles(engine: string, profileType?: string) {
    if (profileType) {
      return this.db.prepare('SELECT engine, profile_type, name, created_at FROM profiles WHERE engine = ? AND profile_type = ?').all(engine, profileType) as DbProfileSummary[];
    }
    return this.db.prepare('SELECT engine, profile_type, name, created_at FROM profiles WHERE engine = ?').all(engine) as DbProfileSummary[];
  }

  getProfile(engine: string, profileType: string, name: string) {
    return this.db.prepare('SELECT * FROM profiles WHERE engine = ? AND profile_type = ? AND name = ?').get(engine, profileType, name) as DbProfile | undefined;
  }

  upsertProfile(engine: string, profileType: string, name: string, settings: string) {
    this.db.prepare(`
      INSERT INTO profiles (engine, profile_type, name, settings) VALUES (?, ?, ?, ?)
      ON CONFLICT(engine, profile_type, name) DO UPDATE SET settings = excluded.settings, updated_at = datetime('now')
    `).run(engine, profileType, name, settings);
  }

  deleteProfile(engine: string, profileType: string, name: string) {
    this.db.prepare('DELETE FROM profiles WHERE engine = ? AND profile_type = ? AND name = ?').run(engine, profileType, name);
  }

  // --- Printers ---

  listPrinters(): DbPrinter[] {
    return this.db.prepare('SELECT * FROM printers ORDER BY created_at ASC').all() as DbPrinter[];
  }

  listPrintQueue(printerId: string): DbPrintQueueItem[] {
    return this.db.prepare(
      'SELECT * FROM print_queue WHERE printer_id = ? ORDER BY added_at ASC',
    ).all(printerId) as DbPrintQueueItem[];
  }

  addPrintQueueItem(item: { id: string; printer_id: string; job_id: string }): void {
    this.db.prepare(
      'INSERT INTO print_queue (id, printer_id, job_id) VALUES (?, ?, ?)',
    ).run(item.id, item.printer_id, item.job_id);
  }

  getPrintQueueItem(id: string): DbPrintQueueItem | undefined {
    return this.db.prepare('SELECT * FROM print_queue WHERE id = ?').get(id) as DbPrintQueueItem | undefined;
  }

  deletePrintQueueItem(id: string): void {
    this.db.prepare('DELETE FROM print_queue WHERE id = ?').run(id);
  }

  getPrinter(id: string): DbPrinter | undefined {
    return this.db.prepare('SELECT * FROM printers WHERE id = ?').get(id) as DbPrinter | undefined;
  }

  insertPrinter(p: {
    id: string; name: string; protocol: string; ip: string; port: number;
    serial?: string | null; access_code?: string | null; api_key?: string | null;
    camera_ip?: string | null;
    camera_stream_url?: string | null;
    camera_snapshot_url?: string | null;
    model?: string | null;
    manual_slots?: number;
    connection_mode?: string | null;
    bambuddy_url?: string | null;
    bambuddy_printer_id?: number | null;
    bambuddy_api_key?: string | null;
  }) {
    this.db.prepare(`
      INSERT INTO printers (id, name, protocol, ip, port, serial, access_code, api_key, camera_ip, camera_stream_url, camera_snapshot_url, model, manual_slots, connection_mode, bambuddy_url, bambuddy_printer_id, bambuddy_api_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(p.id, p.name, p.protocol, p.ip, p.port, p.serial ?? null, enc(p.access_code), enc(p.api_key), p.camera_ip ?? null, p.camera_stream_url ?? null, p.camera_snapshot_url ?? null, p.model ?? null, p.manual_slots ?? 0, p.connection_mode ?? null, p.bambuddy_url ?? null, p.bambuddy_printer_id ?? null, enc(p.bambuddy_api_key));
  }

  updatePrinterModel(id: string, model: string | null) {
    this.db.prepare('UPDATE printers SET model = ? WHERE id = ?').run(model, id);
  }

  updatePrinterFields(id: string, fields: {
    name?: string;
    ip?: string;
    port?: number;
    access_code?: string | null;
    api_key?: string | null;
    camera_stream_url?: string | null;
    camera_snapshot_url?: string | null;
    model?: string | null;
    manual_slots?: number;
    manual_filaments?: string | null;
    connection_mode?: string | null;
    bambuddy_url?: string | null;
    bambuddy_printer_id?: number | null;
    bambuddy_api_key?: string | null;
  }) {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (fields.name !== undefined) { sets.push('name = ?'); vals.push(fields.name); }
    if (fields.ip !== undefined) { sets.push('ip = ?'); vals.push(fields.ip); }
    if (fields.port !== undefined) { sets.push('port = ?'); vals.push(fields.port); }
    if (fields.access_code !== undefined) { sets.push('access_code = ?'); vals.push(enc(fields.access_code)); }
    if (fields.api_key !== undefined) { sets.push('api_key = ?'); vals.push(enc(fields.api_key)); }
    if (fields.camera_stream_url !== undefined) { sets.push('camera_stream_url = ?'); vals.push(fields.camera_stream_url); }
    if (fields.camera_snapshot_url !== undefined) { sets.push('camera_snapshot_url = ?'); vals.push(fields.camera_snapshot_url); }
    if (fields.model !== undefined) { sets.push('model = ?'); vals.push(fields.model); }
    if (fields.manual_slots !== undefined) { sets.push('manual_slots = ?'); vals.push(fields.manual_slots); }
    if (fields.manual_filaments !== undefined) { sets.push('manual_filaments = ?'); vals.push(fields.manual_filaments); }
    if (fields.connection_mode !== undefined) { sets.push('connection_mode = ?'); vals.push(fields.connection_mode); }
    if (fields.bambuddy_url !== undefined) { sets.push('bambuddy_url = ?'); vals.push(fields.bambuddy_url); }
    if (fields.bambuddy_printer_id !== undefined) { sets.push('bambuddy_printer_id = ?'); vals.push(fields.bambuddy_printer_id); }
    if (fields.bambuddy_api_key !== undefined) { sets.push('bambuddy_api_key = ?'); vals.push(enc(fields.bambuddy_api_key)); }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE printers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  updatePrinterStatus(id: string, status: string | null) {
    this.db.prepare('UPDATE printers SET last_status = ?, last_seen = datetime(\'now\') WHERE id = ?').run(status, id);
  }

  deletePrinter(id: string) {
    this.db.prepare('DELETE FROM printers WHERE id = ?').run(id);
  }

  // --- Plates ---

  insertPlate(plate: {
    modelId: string; plateIndex: number; filePath: string;
    faceCount: number; boundsX: number; boundsY: number; boundsZ: number;
  }) {
    this.db.prepare(`
      INSERT INTO model_plates (model_id, plate_index, file_path, face_count, bounds_x, bounds_y, bounds_z)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(plate.modelId, plate.plateIndex, plate.filePath, plate.faceCount, plate.boundsX, plate.boundsY, plate.boundsZ);
  }

  getPlate(modelId: string, plateIndex: number) {
    return this.db.prepare('SELECT * FROM model_plates WHERE model_id = ? AND plate_index = ?')
      .get(modelId, plateIndex) as DbPlate | undefined;
  }

  listPlates(modelId: string) {
    return this.db.prepare('SELECT * FROM model_plates WHERE model_id = ? ORDER BY plate_index')
      .all(modelId) as DbPlate[];
  }

  updatePlateColors(modelId: string, plateIndex: number, colors: Buffer) {
    this.db.prepare('UPDATE model_plates SET face_colors = ? WHERE model_id = ? AND plate_index = ?')
      .run(colors, modelId, plateIndex);
  }

  // --- Negative parts (cutters / modifiers captured at 3MF import) ---

  insertNegativePart(part: {
    modelId: string; plateIndex: number; partIndex: number;
    filePath: string; faceCount: number;
    boundsMinX?: number; boundsMinY?: number; boundsMinZ?: number;
    boundsMaxX?: number; boundsMaxY?: number; boundsMaxZ?: number;
  }) {
    this.db.prepare(`
      INSERT INTO model_negative_parts (model_id, plate_index, part_index, file_path, face_count,
        bounds_min_x, bounds_min_y, bounds_min_z, bounds_max_x, bounds_max_y, bounds_max_z)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(part.modelId, part.plateIndex, part.partIndex, part.filePath, part.faceCount,
      part.boundsMinX ?? null, part.boundsMinY ?? null, part.boundsMinZ ?? null,
      part.boundsMaxX ?? null, part.boundsMaxY ?? null, part.boundsMaxZ ?? null);
  }

  listNegativeParts(modelId: string, plateIndex: number): DbNegativePart[] {
    return this.db.prepare(
      'SELECT * FROM model_negative_parts WHERE model_id = ? AND plate_index = ? ORDER BY part_index',
    ).all(modelId, plateIndex) as DbNegativePart[];
  }

  // --- Printable parts (one per `<object>` in a 3MF assembly) ---

  insertPrintablePart(part: {
    modelId: string; plateIndex: number; partIndex: number;
    filePath: string; faceCount: number;
    name?: string; extruder?: number;
    boundsMinX?: number; boundsMinY?: number; boundsMinZ?: number;
    boundsMaxX?: number; boundsMaxY?: number; boundsMaxZ?: number;
    faceColors?: Buffer;
  }) {
    this.db.prepare(`
      INSERT INTO model_printable_parts
        (model_id, plate_index, part_index, file_path, face_count, name, extruder,
         bounds_min_x, bounds_min_y, bounds_min_z, bounds_max_x, bounds_max_y, bounds_max_z, face_colors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(part.modelId, part.plateIndex, part.partIndex, part.filePath, part.faceCount,
      part.name ?? null, part.extruder ?? null,
      part.boundsMinX ?? null, part.boundsMinY ?? null, part.boundsMinZ ?? null,
      part.boundsMaxX ?? null, part.boundsMaxY ?? null, part.boundsMaxZ ?? null,
      part.faceColors ?? null);
  }

  listPrintableParts(modelId: string, plateIndex: number): DbPrintablePart[] {
    return this.db.prepare(
      'SELECT * FROM model_printable_parts WHERE model_id = ? AND plate_index = ? ORDER BY part_index',
    ).all(modelId, plateIndex) as DbPrintablePart[];
  }

  // --- Spools ---

  listSpools(includeArchived = false): DbSpool[] {
    const sql = includeArchived
      ? 'SELECT * FROM spools ORDER BY created_at DESC'
      : 'SELECT * FROM spools WHERE archived = 0 ORDER BY created_at DESC';
    return this.db.prepare(sql).all() as DbSpool[];
  }

  getSpool(id: string): DbSpool | undefined {
    return this.db.prepare('SELECT * FROM spools WHERE id = ?').get(id) as DbSpool | undefined;
  }

  insertSpool(s: {
    id: string; name: string; color?: string | null; material?: string | null;
    total_weight_g?: number; remaining_weight_g?: number; cost_per_kg?: number;
    purchased_at?: string | null; notes?: string | null;
  }) {
    this.db.prepare(`
      INSERT INTO spools (id, name, color, material, total_weight_g, remaining_weight_g, cost_per_kg, purchased_at, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(s.id, s.name, s.color ?? null, s.material ?? null,
      s.total_weight_g ?? 1000, s.remaining_weight_g ?? 1000, s.cost_per_kg ?? 0,
      s.purchased_at ?? null, s.notes ?? null);
  }

  updateSpool(id: string, fields: Partial<{
    name: string; color: string | null; material: string | null;
    total_weight_g: number; remaining_weight_g: number; cost_per_kg: number;
    purchased_at: string | null; notes: string | null; archived: number;
  }>) {
    const allowed = ['name', 'color', 'material', 'total_weight_g', 'remaining_weight_g', 'cost_per_kg', 'purchased_at', 'notes', 'archived'] as const;
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(fields[k]);
      }
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE spools SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  deleteSpool(id: string) {
    this.db.prepare('DELETE FROM spools WHERE id = ?').run(id);
  }

  // --- Print history ---

  listPrintHistory(limit = 100): DbPrintHistory[] {
    return this.db.prepare('SELECT * FROM print_history ORDER BY completed_at DESC LIMIT ?').all(limit) as DbPrintHistory[];
  }

  getPrintHistory(id: string): DbPrintHistory | undefined {
    return this.db.prepare('SELECT * FROM print_history WHERE id = ?').get(id) as DbPrintHistory | undefined;
  }

  getPrintHistoryByJob(jobId: string): DbPrintHistory | undefined {
    return this.db.prepare('SELECT * FROM print_history WHERE job_id = ?').get(jobId) as DbPrintHistory | undefined;
  }

  insertPrintHistory(h: {
    id: string; job_id?: string | null; printer_id?: string | null;
    model_name?: string | null; completed_at?: string; photo_path?: string | null;
    rating?: number | null; notes?: string | null;
  }) {
    this.db.prepare(`
      INSERT INTO print_history (id, job_id, printer_id, model_name, completed_at, photo_path, rating, notes)
      VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?)
    `).run(h.id, h.job_id ?? null, h.printer_id ?? null, h.model_name ?? null,
      h.completed_at ?? null, h.photo_path ?? null, h.rating ?? null, h.notes ?? null);
  }

  updatePrintHistory(id: string, fields: Partial<{
    photo_path: string | null; rating: number | null; notes: string | null;
    printer_id: string | null;
  }>) {
    const allowed = ['photo_path', 'rating', 'notes', 'printer_id'] as const;
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const k of allowed) {
      if (fields[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(fields[k]);
      }
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE print_history SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  deletePrintHistory(id: string) {
    this.db.prepare('DELETE FROM print_history WHERE id = ?').run(id);
  }

  // --- App settings (key/value, e.g. bambu_cloud_token) ---

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
    `).run(key, value);
  }

  // --- Model provenance (MakerWorld dedup) ---

  findModelBySourceUrl(sourceUrl: string): DbModel | undefined {
    return this.db.prepare('SELECT * FROM models WHERE source_url = ?').get(sourceUrl) as DbModel | undefined;
  }

  updateModelSource(id: string, sourceType: string, sourceUrl: string | null) {
    this.db.prepare('UPDATE models SET source_type = ?, source_url = ? WHERE id = ?').run(sourceType, sourceUrl, id);
  }

  updateModelSourceSettings(id: string, settingsJson: string) {
    this.db.prepare('UPDATE models SET source_settings = ? WHERE id = ?').run(settingsJson, id);
  }

  close() {
    this.db.close();
  }
}

// Database row types
export interface DbModel {
  id: string; name: string; file_path: string; file_size: number;
  format: string; face_count: number; face_colors: Buffer | null;
  bounds_x: number; bounds_y: number; bounds_z: number;
  plate_count: number; created_at: string;
  source_type: string | null;
  source_url: string | null;
  source_settings: string | null;
  bounds_min_x: number | null; bounds_min_y: number | null; bounds_min_z: number | null;
  bounds_max_x: number | null; bounds_max_y: number | null; bounds_max_z: number | null;
}

export interface DbModelSummary {
  id: string; name: string; format: string; face_count: number; file_size: number; plate_count: number; created_at: string;
}

export interface DbJob {
  id: string; model_id: string; engine: string; status: string;
  progress: number; current_step: string | null; settings: string;
  output_dir: string | null; gcode_size: number | null;
  model_name: string | null; estimated_time: string | null;
  filament_used_g: number | null; filament_cost: number | null;
  error_message: string | null; created_at: string;
  started_at: string | null; completed_at: string | null;
  printer_id: string | null; printer_name: string | null;
}

export interface DbProfileSummary {
  engine: string; profile_type: string; name: string; created_at: string;
}

export interface DbProfile {
  engine: string; profile_type: string; name: string; settings: string; created_at: string; updated_at: string;
}

export interface DbPlate {
  model_id: string; plate_index: number; file_path: string;
  face_count: number; bounds_x: number; bounds_y: number; bounds_z: number;
  face_colors: Buffer | null;
}

export interface DbNegativePart {
  model_id: string; plate_index: number; part_index: number;
  file_path: string; face_count: number;
  bounds_min_x: number | null; bounds_min_y: number | null; bounds_min_z: number | null;
  bounds_max_x: number | null; bounds_max_y: number | null; bounds_max_z: number | null;
}

export interface DbPrintablePart {
  model_id: string; plate_index: number; part_index: number;
  file_path: string; face_count: number;
  name: string | null; extruder: number | null;
  bounds_min_x: number | null; bounds_min_y: number | null; bounds_min_z: number | null;
  bounds_max_x: number | null; bounds_max_y: number | null; bounds_max_z: number | null;
  face_colors: Buffer | null;
}

export interface DbPrinter {
  id: string;
  name: string;
  protocol: string;       // 'moonraker' | 'bambu'
  ip: string;
  port: number;
  serial: string | null;
  access_code: string | null;
  api_key: string | null;
  camera_ip: string | null;
  camera_stream_url: string | null;
  camera_snapshot_url: string | null;
  model: string | null;
  manual_slots: number;   // multi-material slot count for printers with no live introspection (e.g. Creality CFS)
  connection_mode: string | null;  // 'direct' (default null) | 'bambuddy' — Bambu only
  bambuddy_url: string | null;
  bambuddy_printer_id: number | null;
  bambuddy_api_key: string | null;
  last_status: string | null;
  last_seen: string | null;
  created_at: string;
}

export interface DbSpool {
  id: string;
  name: string;
  color: string | null;
  material: string | null;
  total_weight_g: number;
  remaining_weight_g: number;
  cost_per_kg: number;
  purchased_at: string | null;
  notes: string | null;
  archived: number;       // 0 | 1
  created_at: string;
}

export interface DbPrintHistory {
  id: string;
  job_id: string | null;
  printer_id: string | null;
  model_name: string | null;
  completed_at: string;
  photo_path: string | null;
  rating: number | null;
  notes: string | null;
  created_at: string;
}

export interface DbPrintQueueItem {
  id: string;
  printer_id: string;
  job_id: string;
  added_at: string;
}
