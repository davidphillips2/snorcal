import type Database from 'better-sqlite3';
import fs from 'fs';
import { parseSTL } from '../services/model-parser.js';

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    format TEXT NOT NULL,
    face_count INTEGER NOT NULL,
    face_colors BLOB,
    bounds_x REAL NOT NULL,
    bounds_y REAL NOT NULL,
    bounds_z REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    engine TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0,
    current_step TEXT,
    settings TEXT NOT NULL,
    output_dir TEXT,
    gcode_size INTEGER,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS profiles (
    engine TEXT NOT NULL,
    profile_type TEXT NOT NULL DEFAULT 'process',
    name TEXT NOT NULL,
    settings TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (engine, profile_type, name)
  )`,

  `CREATE TABLE IF NOT EXISTS model_plates (
    model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    plate_index INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    face_count INTEGER NOT NULL,
    bounds_x REAL, bounds_y REAL, bounds_z REAL,
    face_colors BLOB,
    PRIMARY KEY (model_id, plate_index)
  )`,

  `CREATE TABLE IF NOT EXISTS printers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    ip TEXT NOT NULL,
    port INTEGER NOT NULL,
    serial TEXT,
    access_code TEXT,
    api_key TEXT,
    last_status TEXT,
    last_seen TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE INDEX IF NOT EXISTS idx_jobs_model_id ON jobs(model_id)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at)`,
];

/**
 * Run migrations that modify existing schema.
 * These use try/catch since they may fail if already applied.
 */
export function runSchemaMigrations(db: Database.Database) {
  // Migrate old profiles table (without profile_type column) to new schema
  try {
    const cols = db.prepare("PRAGMA table_info(profiles)").all() as { name: string }[];
    const hasProfileType = cols.some(c => c.name === 'profile_type');
    if (!hasProfileType) {
      db.exec('ALTER TABLE profiles RENAME TO profiles_old');
      db.exec(`
        CREATE TABLE profiles (
          engine TEXT NOT NULL,
          profile_type TEXT NOT NULL DEFAULT 'process',
          name TEXT NOT NULL,
          settings TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (engine, profile_type, name)
        )
      `);
      db.exec(`INSERT OR IGNORE INTO profiles (engine, profile_type, name, settings, created_at, updated_at)
               SELECT engine, 'process', name, settings, created_at, updated_at FROM profiles_old`);
      db.exec('DROP TABLE profiles_old');
    }
  } catch {
    // Migration not needed or already applied
  }

  // Add estimate columns to jobs table
  try {
    const cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
    if (!cols.some(c => c.name === 'model_name')) {
      db.exec("ALTER TABLE jobs ADD COLUMN model_name TEXT");
    }
    if (!cols.some(c => c.name === 'estimated_time')) {
      db.exec("ALTER TABLE jobs ADD COLUMN estimated_time TEXT");
    }
    if (!cols.some(c => c.name === 'filament_used_g')) {
      db.exec("ALTER TABLE jobs ADD COLUMN filament_used_g REAL");
    }
    if (!cols.some(c => c.name === 'filament_cost')) {
      db.exec("ALTER TABLE jobs ADD COLUMN filament_cost REAL");
    }
  } catch {
    // Migration not needed or already applied
  }

  // Add plate_count column to models table
  try {
    const cols = db.prepare("PRAGMA table_info(models)").all() as { name: string }[];
    if (!cols.some(c => c.name === 'plate_count')) {
      db.exec("ALTER TABLE models ADD COLUMN plate_count INTEGER NOT NULL DEFAULT 1");
    }
  } catch {
    // Migration not needed or already applied
  }

  // Add printer_id column to jobs table
  try {
    const cols = db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[];
    if (!cols.some(c => c.name === 'printer_id')) {
      db.exec("ALTER TABLE jobs ADD COLUMN printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL");
    }
  } catch {
    // Migration not needed or already applied
  }

  // Add camera_ip column to printers (override `ip` for camera fetches)
  try {
    const cols = db.prepare("PRAGMA table_info(printers)").all() as { name: string }[];
    if (!cols.some(c => c.name === 'camera_ip')) {
      db.exec("ALTER TABLE printers ADD COLUMN camera_ip TEXT");
    }
  } catch {
    // Migration not needed or already applied
  }

  // Add custom camera stream/snapshot URL columns (full URL override)
  try {
    const cols = db.prepare("PRAGMA table_info(printers)").all() as { name: string }[];
    if (!cols.some(c => c.name === 'camera_stream_url')) {
      db.exec("ALTER TABLE printers ADD COLUMN camera_stream_url TEXT");
    }
    if (!cols.some(c => c.name === 'camera_snapshot_url')) {
      db.exec("ALTER TABLE printers ADD COLUMN camera_snapshot_url TEXT");
    }
  } catch {
    // Migration not needed or already applied
  }

  // Add model column to printers (machine profile name for slicer filter)
  try {
    const cols = db.prepare("PRAGMA table_info(printers)").all() as { name: string }[];
    if (!cols.some(c => c.name === 'model')) {
      db.exec("ALTER TABLE printers ADD COLUMN model TEXT");
    }
  } catch {
    // Migration not needed or already applied
  }

  // Add manual_slots column (multi-material slot count for printers we can't introspect, e.g. Creality CFS)
  try {
    const cols = db.prepare("PRAGMA table_info(printers)").all() as { name: string }[];
    if (!cols.some(c => c.name === 'manual_slots')) {
      db.exec("ALTER TABLE printers ADD COLUMN manual_slots INTEGER DEFAULT 0");
    }
    // Per-slot filament metadata for non-AMS printers (color/type/brand/remain).
    // JSON array of { color, type, brand, remain } entries, indexed by slot.
    if (!cols.some(c => c.name === 'manual_filaments')) {
      db.exec("ALTER TABLE printers ADD COLUMN manual_filaments TEXT DEFAULT NULL");
    }
  } catch {
    // Migration not needed or already applied
  }

  // Spools inventory (filament tracking)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS spools (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT,
        material TEXT,
        total_weight_g REAL NOT NULL DEFAULT 1000,
        remaining_weight_g REAL NOT NULL DEFAULT 1000,
        cost_per_kg REAL NOT NULL DEFAULT 0,
        purchased_at TEXT,
        notes TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  } catch { /* already exists */ }

  // Print history (post-completion notes + photos)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS print_history (
        id TEXT PRIMARY KEY,
        job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
        printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL,
        model_name TEXT,
        completed_at TEXT NOT NULL DEFAULT (datetime('now')),
        photo_path TEXT,
        rating INTEGER,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  } catch { /* already exists */ }

  // Negative parts (cutters / modifiers) captured per plate at 3MF import.
  // Re-emitted as Bambu negative volumes during slice so the slicer applies
  // boolean cuts at slice time.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_negative_parts (
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        plate_index INTEGER NOT NULL,
        part_index INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        face_count INTEGER NOT NULL,
        PRIMARY KEY (model_id, plate_index, part_index)
      )
    `);
  } catch { /* already exists */ }

  // Printable parts (one per `<object>` in a 3MF assembly) — surfaces
  // multi-object imports as interactable children of the parent model.
  // Distinct from model_negative_parts: these are printable geometry that
  // compose the assembly (each becomes a `<component>` of the wrapper object
  // in the output 3MF). Model_negative_parts stay non-printable cutters.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_printable_parts (
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        plate_index INTEGER NOT NULL,
        part_index INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        face_count INTEGER NOT NULL,
        name TEXT,
        extruder INTEGER,
        bounds_min_x REAL, bounds_min_y REAL, bounds_min_z REAL,
        bounds_max_x REAL, bounds_max_y REAL, bounds_max_z REAL,
        face_colors BLOB,
        PRIMARY KEY (model_id, plate_index, part_index)
      )
    `);
  } catch { /* already exists */ }

  // app_settings — key/value, runtime-editable (e.g. bambu_cloud_token)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  } catch { /* already exists */ }

  // Models provenance (MakerWorld dedup + display)
  try {
    const mCols = db.prepare("PRAGMA table_info(models)").all() as { name: string }[];
    if (!mCols.some(c => c.name === 'source_type')) {
      db.exec("ALTER TABLE models ADD COLUMN source_type TEXT");
    }
    if (!mCols.some(c => c.name === 'source_url')) {
      db.exec("ALTER TABLE models ADD COLUMN source_url TEXT");
    }
    if (!mCols.some(c => c.name === 'source_settings')) {
      db.exec("ALTER TABLE models ADD COLUMN source_settings TEXT");
    }
    // Plate-1 bounds (min + max in raw STL coordinates). Lets the frontend
    // surface embedded negative parts as children on MakerWorld imports,
    // which go through GET /api/models/:id (not the upload response).
    if (!mCols.some(c => c.name === 'bounds_min_x')) {
      db.exec("ALTER TABLE models ADD COLUMN bounds_min_x REAL");
      db.exec("ALTER TABLE models ADD COLUMN bounds_min_y REAL");
      db.exec("ALTER TABLE models ADD COLUMN bounds_min_z REAL");
      db.exec("ALTER TABLE models ADD COLUMN bounds_max_x REAL");
      db.exec("ALTER TABLE models ADD COLUMN bounds_max_y REAL");
      db.exec("ALTER TABLE models ADD COLUMN bounds_max_z REAL");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_models_source_url ON models(source_url)");
  } catch { /* migration not needed */ }

  // Negative parts bounds — same reason. Without these, MakerWorld imports
  // (which don't see the upload response) can't compute child offsets.
  try {
    const npCols = db.prepare("PRAGMA table_info(model_negative_parts)").all() as { name: string }[];
    if (!npCols.some(c => c.name === 'bounds_min_x')) {
      db.exec("ALTER TABLE model_negative_parts ADD COLUMN bounds_min_x REAL");
      db.exec("ALTER TABLE model_negative_parts ADD COLUMN bounds_min_y REAL");
      db.exec("ALTER TABLE model_negative_parts ADD COLUMN bounds_min_z REAL");
      db.exec("ALTER TABLE model_negative_parts ADD COLUMN bounds_max_x REAL");
      db.exec("ALTER TABLE model_negative_parts ADD COLUMN bounds_max_y REAL");
      db.exec("ALTER TABLE model_negative_parts ADD COLUMN bounds_max_z REAL");
    }
  } catch { /* migration not needed */ }

  // Backfill bounds_min/max for rows that predate the columns above. Without
  // this, MakerWorld imports (which read bounds via GET /api/models/:id) can't
  // surface embedded negatives as children. Re-parses the stored STL plate.
  try {
    const staleModels = db.prepare(
      "SELECT id, file_path FROM models WHERE bounds_min_x IS NULL",
    ).all() as { id: string; file_path: string }[];
    for (const row of staleModels) {
      if (!fs.existsSync(row.file_path)) continue;
      try {
        const parsed = parseSTL(row.file_path);
        if (!parsed.boundsMin || !parsed.boundsMax) continue;
        db.prepare(
          "UPDATE models SET bounds_min_x=?, bounds_min_y=?, bounds_min_z=?, bounds_max_x=?, bounds_max_y=?, bounds_max_z=? WHERE id=?",
        ).run(parsed.boundsMin.x, parsed.boundsMin.y, parsed.boundsMin.z,
          parsed.boundsMax.x, parsed.boundsMax.y, parsed.boundsMax.z, row.id);
      } catch { /* skip unreadable STL */ }
    }

    const staleNegatives = db.prepare(
      "SELECT model_id, plate_index, part_index, file_path FROM model_negative_parts WHERE bounds_min_x IS NULL",
    ).all() as { model_id: string; plate_index: number; part_index: number; file_path: string }[];
    for (const row of staleNegatives) {
      if (!fs.existsSync(row.file_path)) continue;
      try {
        const parsed = parseSTL(row.file_path);
        if (!parsed.boundsMin || !parsed.boundsMax) continue;
        db.prepare(
          "UPDATE model_negative_parts SET bounds_min_x=?, bounds_min_y=?, bounds_min_z=?, bounds_max_x=?, bounds_max_y=?, bounds_max_z=? WHERE model_id=? AND plate_index=? AND part_index=?",
        ).run(parsed.boundsMin.x, parsed.boundsMin.y, parsed.boundsMin.z,
          parsed.boundsMax.x, parsed.boundsMax.y, parsed.boundsMax.z,
          row.model_id, row.plate_index, row.part_index);
      } catch { /* skip unreadable STL */ }
    }
  } catch { /* backfill best-effort */ }
}
