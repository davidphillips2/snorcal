import Database from 'better-sqlite3';
import { MIGRATIONS, runSchemaMigrations } from './migrations.js';
import { seedDefaultProfiles } from './seed-profiles.js';

export class Db {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
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
  }) {
    this.db.prepare(`
      INSERT INTO models (id, name, file_path, file_size, format, face_count, bounds_x, bounds_y, bounds_z, plate_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(model.id, model.name, model.filePath, model.fileSize, model.format,
      model.faceCount, model.boundsX, model.boundsY, model.boundsZ, model.plateCount ?? 1);
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
  }) {
    this.db.prepare(`
      INSERT INTO jobs (id, model_id, engine, settings, output_dir)
      VALUES (?, ?, ?, ?, ?)
    `).run(job.id, job.modelId, job.engine, job.settings, job.outputDir);
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
  }) {
    this.db.prepare(`
      INSERT INTO printers (id, name, protocol, ip, port, serial, access_code, api_key, camera_ip, camera_stream_url, camera_snapshot_url, model, manual_slots)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(p.id, p.name, p.protocol, p.ip, p.port, p.serial ?? null, p.access_code ?? null, p.api_key ?? null, p.camera_ip ?? null, p.camera_stream_url ?? null, p.camera_snapshot_url ?? null, p.model ?? null, p.manual_slots ?? 0);
  }

  updatePrinterModel(id: string, model: string | null) {
    this.db.prepare('UPDATE printers SET model = ? WHERE id = ?').run(model, id);
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
  printer_id: string | null;
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

export interface DbPrinter {
  id: string;
  name: string;
  protocol: string;       // 'moonraker' | 'bambu' | 'snapmaker'
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
