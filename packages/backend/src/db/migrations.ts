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
}
