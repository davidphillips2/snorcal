import type Database from 'better-sqlite3';

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
}
