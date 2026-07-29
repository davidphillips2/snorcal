import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuid } from 'uuid';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/index.js';
import { getQueue } from '../jobs/queue.js';
import { ensureDir, getJobsDir } from '../services/model-parser.js';
import { build3MF, type ThreeMFModelInput } from '../services/threemf-builder.js';
import { SlicerExecutor } from '../services/slicer-executor.js';
import { findGcodeFile } from '../services/gcode-utils.js';
import type { SliceRequest, SliceJobData, MultiMaterialConfig, FilamentSlot } from '@snorcal/shared';
import os from 'node:os';

// In-flight slicer executors keyed by jobId, so the cancel route can abort a
// running slice. Populated in runSliceJob, cleared in its finally. Without
// this, the cancel route could only reach the BullMQ queue (not the executor)
// and a direct-mode (no-Redis) slice was uncancellable.
const runningExecutors = new Map<string, SlicerExecutor>();

// Load the full default project settings template (slicer-exported defaults)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectSettingsRaw = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'default-project-settings.json'), 'utf-8'),
);

/**
 * Build a bambuddy-style profile stub for sidecar slice_with_profiles.
 * Returns JSON string `{name, inherits: name, from: "system", type}`. The
 * sidecar walks `inherits` against its bundled slicer presets to produce
 * the full resolved profile, then passes via --load-settings (machine /
 * process) or --load-filaments (one per slot). Mirrors bambuddy
 * `_resolve_standard` (preset_resolver.py:254-277). Avoids needing full
 * resolved JSON in snorcal's DB (which has truncated arrays per v0.1.13).
 */
function buildProfileStub(name: string, type: 'machine' | 'process' | 'filament'): string {
  return JSON.stringify({ name, inherits: name, from: 'system', type });
}

/**
 * Read a single engine's binary path override from the DB-backed
 * `slicer_path_overrides` app setting (set via App Settings UI). Returns
 * undefined when no override is set for the engine or the JSON is malformed.
 * Spawn path passes this into `getSlicerBinary(engine, override)`.
 */
function readBinaryOverride(db: Db, engine: string): string | undefined {
  try {
    const raw = db.getSetting('slicer_path_overrides');
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const v = (parsed as Record<string, unknown>)[engine];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch { /* malformed — ignore */ }
  return undefined;
}

/** Get default slicer datadir for the current platform and engine */
function getDefaultDataDir(engine: string): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const macDirs: Record<string, string> = {
      orcaslicer: 'OrcaSlicer',
      bambustudio: 'BambuStudio',
      prusaslicer: 'PrusaSlicer',
    };
    return path.join(home, 'Library', 'Application Support', macDirs[engine] ?? 'OrcaSlicer');
  }
  // Linux (Docker)
  const linuxDirs: Record<string, string> = {
    orcaslicer: 'OrcaSlicer',
    bambustudio: 'BambuStudio',
    prusaslicer: 'PrusaSlicer',
  };
  return path.join(home, '.config', linuxDirs[engine] ?? 'OrcaSlicer');
}

/**
 * Derive a canonical material type token (PLA, PETG, ABS, TPU, ...) from a
 * filament profile name. Profile names follow slicer convention
 * "<Vendor> <Material> @<Printer>", e.g. "SUNLU PETG @BBL X1C",
 * "Bambu PLA Basic @BBL P1S". Returns the matched material or null.
 */
const MATERIAL_TOKENS = ['PETG', 'PLA', 'ABS', 'ASA', 'TPU', 'PA', 'PC', 'PVA', 'HIPS', 'PEEK', 'PEI', 'Nylon', 'CF', 'GF'] as const;
function deriveMaterialFromProfileName(profile: string): string | null {
  const upper = profile.toUpperCase();
  // Longest-match first so "PA-CF" doesn't resolve to "PA" before "PA-CF".
  // The current token list has no overlap so simple find works, but keep
  // this sorted by length to harden against future additions.
  const sorted = [...MATERIAL_TOKENS].sort((a, b) => b.length - a.length);
  for (const t of sorted) {
    if (upper.includes(t.toUpperCase())) return t;
  }
  return null;
}

/**
 * Override nozzle_temperature / nozzle_temperature_initial_layer in
 * project_settings when the user's chosen filament type differs from the
 * type embedded in the 3MF. OrcaSlicer reads nozzle_temperature as a
 * top-level scalar (not a filament_* key), so setting filament_type alone
 * doesn't change the temp — the slicer uses whatever the 3MF embedded.
 *
 * Looks up the correct temp from the DB filament profile matching the
 * user's type + printer model. Falls back to the first matching-type
 * profile if no printer-specific one is found. Silently skips if no
 * profile is found (keeps the embedded temp).
 */
/**
 * Resolve a setting key by walking a filament profile's `inherits` chain.
 * OrcaSlicer/BambuStudio profiles use `"inherits": "Parent Name"` — the
 * child only carries overridden keys, so missing keys must be fetched from
 * the parent (which may itself inherit). Depth-limited to 10 to prevent
 * cycles.
 */
function resolveInherited(
  engine: string,
  profileName: string,
  key: string,
  db: Db,
  depth: number = 0,
): unknown {
  if (depth > 10) return undefined;
  const prof = db.getProfile(engine, 'filament', profileName);
  if (!prof) return undefined;
  let ps: Record<string, unknown>;
  try { ps = JSON.parse(prof.settings); } catch { return undefined; }
  if (ps[key] !== undefined && ps[key] !== null && ps[key] !== '') return ps[key];
  const parent = typeof ps['inherits'] === 'string' ? ps['inherits'] as string : undefined;
  if (parent) return resolveInherited(engine, parent, key, db, depth + 1);
  return undefined;
}

function overrideNozzleTemps(
  projectSettings: Record<string, unknown>,
  slots: FilamentSlot[],
  originalFilamentTypes: string[],
  engine: string,
  db: Db,
): void {
  for (let i = 0; i < slots.length; i++) {
    const slotType = slots[i]?.type?.toUpperCase();
    const embeddedType = originalFilamentTypes[i]?.toUpperCase();
    if (!slotType || slotType === embeddedType) continue; // same type, no override needed

    // Use the filament profile the user actually selected (stored in
    // default_filament_profile by the profile-loading path above). This is
    // the exact profile OrcaSlicer resolves — resolve its nozzle_temperature
    // through the inherits chain. Falls back to slot.profile if present.
    const defaultFilamentProfiles = Array.isArray(projectSettings['default_filament_profile'])
      ? (projectSettings['default_filament_profile'] as string[])
      : [];
    const profileName = slots[i]?.profile ?? defaultFilamentProfiles[i];
    if (!profileName) continue;

    // Skip if the profile has no nozzle_temperature — nothing to override.
    if (resolveInherited(engine, profileName, 'nozzle_temperature', db) === undefined) continue;

    // Override nozzle + bed temperatures from the selected filament profile.
    // OrcaSlicer expects these as string arrays (one per extruder). Scalar
    // numbers cause "invalid json type" parse errors and the slicer silently
    // falls back to the embedded (wrong) temp.
    const colourCount = Array.isArray(projectSettings['filament_colour'])
      ? (projectSettings['filament_colour'] as string[]).length : 1;
    const setTempArray = (key: string, profileKey?: string) => {
      const val = resolveInherited(engine, profileName, profileKey ?? key, db);
      if (val === undefined) return;
      const str = Array.isArray(val) ? String((val as unknown[])[0]) : String(val);
      projectSettings[key] = Array(colourCount).fill(str);
    };
    setTempArray('nozzle_temperature');
    setTempArray('nozzle_temperature_initial_layer');
    // Bed temps are per plate type — override all so whichever plate type the
    // user selected gets the correct temp for the new filament type.
    setTempArray('cool_plate_temp');
    setTempArray('cool_plate_temp_initial_layer');
    setTempArray('cool_plate_temp_initial_layer');
    setTempArray('eng_plate_temp');
    setTempArray('eng_plate_temp_initial_layer');
    setTempArray('hot_plate_temp');
    setTempArray('hot_plate_temp_initial_layer');
    setTempArray('textured_plate_temp');
    setTempArray('textured_plate_temp_initial_layer');
    setTempArray('supertack_plate_temp');
    setTempArray('supertack_plate_temp_initial_layer');
    break;
  }
}

/**
 * Expand filament_* settings per user's filamentSlots.
 *
 * Bambuddy parity: NO padding, NO array-length forcing, NO SEMM/prime_tower
 * override, NO printer_model rewrite. The uploaded profile stubs
 * (machine/process/filament) drive the slicer's printer model + extruder
 * count; this function only sets the user's per-slot colour/type choices
 * on `filament_colour` / `filament_type` and expands the rest of the
 * filament_* keys to slots.length using the per-slot filament profile
 * values where available, so each slot carries its own settings.
 */
function expandFilamentSlots(
  projectSettings: Record<string, unknown>,
  slots: FilamentSlot[],
  profileSettings: (Record<string, unknown> | null)[],
): void {
  const n = slots.length;

  // Per-slot colour + type straight from the user's picker.
  projectSettings['filament_colour'] = slots.map(s => s.color);
  projectSettings['filament_type'] = slots.map(s => s.type);

  // Metadata keys that OrcaSlicer treats as scalar (Preset.hpp BBL_JSON_KEY_*).
  // Expanding these to arrays breaks load_from_json's key_values.emplace()
  // which expects string → throws type_error 302, aborting config parse.
  const FILAMENT_METADATA_SCALARS = new Set(['filament_id']);

  // Collect all filament_* keys from per-slot profiles AND existing project settings.
  const filamentKeys = new Set<string>();
  for (const p of profileSettings) {
    if (p) for (const key of Object.keys(p)) {
      if (key.startsWith('filament_') && !FILAMENT_METADATA_SCALARS.has(key)) filamentKeys.add(key);
    }
  }
  for (const key of Object.keys(projectSettings)) {
    if (key.startsWith('filament_') && Array.isArray(projectSettings[key]) && !FILAMENT_METADATA_SCALARS.has(key)) filamentKeys.add(key);
  }

  // Expand each filament_* key to slots.length. Use per-slot profile value
  // when present; else fall back to first non-empty profile value; else
  // existing project setting; else empty string.
  // Profile values may be ARRAYS (Bambu filament profiles carry per-extruder
  // arrays like filament_overhang_2_4_speed=['50','50']). For slot i, take
  // element [i] of that array — DO NOT String() the whole array (joins to
  // "50,50" which the slicer reads as a single corrupted value).
  const pickSlotValue = (v: unknown, i: number): string => {
    if (Array.isArray(v)) return String(v[i] ?? v[0] ?? '');
    return String(v);
  };
  for (const key of filamentKeys) {
    if (key === 'filament_colour' || key === 'filament_type') continue; // already set
    const existing = projectSettings[key] as any[] | undefined;
    const profileFallback = profileSettings.find(p => p && p[key] !== undefined && p[key] !== '');
    const expanded = profileSettings.map((p, i) => {
      if (p && p[key] !== undefined && p[key] !== '') return pickSlotValue(p[key], i);
      if (profileFallback) return pickSlotValue(profileFallback[key], i);
      return pickSlotValue(existing, i) || '';
    });
    while (expanded.length < n) expanded.push(expanded[expanded.length - 1] || '');
    projectSettings[key] = expanded;
  }
}

/**
 * Legacy 2-slot merge for multi-material support mode.
 */
function mergeFilamentProfiles(
  projectSettings: Record<string, unknown>,
  profile0: Record<string, unknown> | null,
  profile1: Record<string, unknown> | null,
  config: MultiMaterialConfig,
): void {
  projectSettings['support_filament'] = config.supportFilament;
  projectSettings['support_interface_filament'] = config.supportInterfaceFilament;

  // filament_id is scalar metadata (Preset.hpp BBL_JSON_KEY_FILAMENT_ID) — never expand
  const filamentKeys = new Set<string>();
  if (profile0) for (const key of Object.keys(profile0)) { if (key.startsWith('filament_') && key !== 'filament_id') filamentKeys.add(key); }
  if (profile1) for (const key of Object.keys(profile1)) { if (key.startsWith('filament_') && key !== 'filament_id') filamentKeys.add(key); }

  for (const key of filamentKeys) {
    const val0 = profile0?.[key];
    const val1 = profile1?.[key];
    projectSettings[key] = [
      val0 !== undefined ? String(val0) : (projectSettings[key] as any)?.[0] ?? '',
      val1 !== undefined ? String(val1) : (projectSettings[key] as any)?.[1] ?? '',
    ];
  }

  const defaultFlush = 280;
  const existing = projectSettings['flush_volumes_matrix'] as string[] | undefined;
  projectSettings['flush_volumes_matrix'] = [
    existing?.[0] ?? '0', existing?.[1] ?? String(defaultFlush),
    existing?.[2] ?? String(defaultFlush), existing?.[3] ?? '0',
  ];
}

export async function sliceRoutes(app: FastifyInstance, options: { db: Db }) {
  const { db } = options;

  // POST /api/slice — Submit a slice job
  app.post('/api/slice', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as SliceRequest;

    if ((!body.modelId && !body.models) || !body.engine || !body.settings) {
      return reply.status(400).send({ ok: false, error: 'modelId (or models), engine, and settings are required' });
    }

    // Validate model(s) exist
    if (body.modelId) {
      const model = db.getModel(body.modelId);
      if (!model) {
        return reply.status(404).send({ ok: false, error: 'Model not found' });
      }
    }
    if (body.models) {
      for (const entry of body.models) {
        const model = db.getModel(entry.modelId);
        if (!model) {
          return reply.status(404).send({ ok: false, error: `Model ${entry.modelId} not found` });
        }
      }
    }

    const validEngines: string[] = ['orcaslicer', 'bambustudio', 'prusaslicer'];
    if (!validEngines.includes(body.engine)) {
      return reply.status(400).send({ ok: false, error: `Invalid engine: ${body.engine}` });
    }

    const jobId = uuid();
    const workDir = path.join(getJobsDir(), jobId);
    ensureDir(workDir);

    const primaryModelId = body.modelId || body.models?.[0]?.modelId || '';
    const primaryModel = body.modelId ? db.getModel(body.modelId) : db.getModel(primaryModelId);

    // Snapshot printer name at slice time. Prefer DB record by printerId;
    // fall back to the machine profile name (e.g. "Snapmaker U1 (0.4 nozzle)")
    // when user has no DB printer registered. Stored denormalized so the job
    // card can render without a JOIN and survives printer renames/deletes.
    let snapshotPrinterName: string | null = null;
    if (body.printerId) {
      const p = db.getPrinter(body.printerId);
      if (p?.name) snapshotPrinterName = p.name;
    }
    if (!snapshotPrinterName && body.profiles?.machine) {
      snapshotPrinterName = body.profiles.machine;
    }

    db.insertJob({
      id: jobId,
      modelId: primaryModelId,
      engine: body.engine,
      settings: JSON.stringify(body.settings),
      outputDir: path.join(workDir, 'output'),
      printerId: body.printerId ?? null,
      printerName: snapshotPrinterName,
    });

    // Try BullMQ queue first, fall back to direct execution
    let useQueue = false;
    try {
      getQueue();
      useQueue = true;
    } catch {
      // Queue unavailable — run directly
    }

    if (useQueue) {
      const queue = getQueue();
      const jobData: SliceJobData = {
        jobId,
        modelId: primaryModelId,
        engine: body.engine,
        plateIndex: body.plateIndex ?? 0,
        settings: body.settings,
        profiles: body.profiles,
        multiMaterial: body.multiMaterial,
        filamentSlots: body.filamentSlots,
        workDir,
      };
      await queue.add('slice', jobData, { jobId });
    } else {
      // Direct execution (no Redis) — run in background, return immediately
      runSliceDirect(jobId, body, primaryModel!.file_path, primaryModel!.name, workDir, db);
    }

    return reply.send({ ok: true, data: { jobId } });
  });

  // GET /api/jobs — List jobs
  app.get('/api/jobs', async (req) => {
    const { status } = req.query as { status?: string };
    const jobs = db.listJobs(status);
    // Batch-fetch printers once to map printer_id → name (avoids N+1 queries).
    // Falls back to printer_settings_id embedded in settings JSON for jobs
    // sliced before printer_id column existed.
    const printers = db.listPrinters();
    const printerNameById = new Map(printers.map(p => [p.id, p.name]));
    // SQLite datetime('now') returns UTC "YYYY-MM-DD HH:MM:SS" with no zone
    // suffix. Frontend Date constructor treats that as local time, shifting
    // displayed time by the user's UTC offset. Append Z so it parses as UTC.
    const toIso = (s: string | null | undefined): string | null =>
      s && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : (s ?? null);
    return {
      ok: true,
      data: jobs.map((j) => {
        // Prefer denormalized snapshot (covers no-printer-DB case via
        // body.profiles.machine). Then DB printer by id. Then embedded
        // settings.printer_settings_id for very old jobs.
        let printerName: string | null = j.printer_name ?? null;
        if (!printerName && j.printer_id) {
          printerName = printerNameById.get(j.printer_id) ?? null;
        }
        if (!printerName) {
          try {
            const s = JSON.parse(j.settings);
            const m = s?.printer_settings_id;
            if (typeof m === 'string' && m) printerName = m;
          } catch { /* ignore */ }
        }
        return {
          id: j.id,
          modelId: j.model_id,
          modelName: j.model_name,
          engine: j.engine,
          status: j.status,
          progress: j.progress,
          currentStep: j.current_step,
          gcodeSize: j.gcode_size,
          estimatedTime: j.estimated_time,
          filamentUsedG: j.filament_used_g,
          filamentCost: j.filament_cost,
          printerName,
          createdAt: toIso(j.created_at),
        };
      }),
    };
  });

  // GET /api/jobs/:id — Get job detail
  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = db.getJob(req.params.id);
    if (!job) {
      return reply.status(404).send({ ok: false, error: 'Job not found' });
    }

    return {
      ok: true,
      data: {
        id: job.id,
        modelId: job.model_id,
        modelName: job.model_name,
        engine: job.engine,
        status: job.status,
        progress: job.progress,
        currentStep: job.current_step,
        settings: JSON.parse(job.settings),
        gcodeSize: job.gcode_size,
        estimatedTime: job.estimated_time,
        filamentUsedG: job.filament_used_g,
        filamentCost: job.filament_cost,
        errorMessage: job.error_message,
        createdAt: job.created_at,
        startedAt: job.started_at,
        completedAt: job.completed_at,
      },
    };
  });

  // GET /api/jobs/:id/filaments — Parse gcode for required filaments
  // Returns FilamentInfo[] for the FilamentRemapModal UI.
  app.get<{ Params: { id: string } }>('/api/jobs/:id/filaments', async (req, reply) => {
    const job = db.getJob(req.params.id);
    if (!job) return reply.status(404).send({ ok: false, error: 'Job not found' });
    if (!job.output_dir) return reply.status(400).send({ ok: false, error: 'No output dir' });
    const gcodePath = findGcodeFile(job.output_dir);
    if (!gcodePath) return reply.status(400).send({ ok: false, error: 'No gcode file' });
    const { parseGcodeFilaments } = await import('../services/gcode-filaments.js');
    const filaments = parseGcodeFilaments(gcodePath);
    return { ok: true, data: filaments };
  });

  // GET /api/jobs/:id/pauses — Read stored manual pause points
  // Returns PausePoint[] (0 = first layer). Empty array if none.
  app.get<{ Params: { id: string } }>('/api/jobs/:id/pauses', async (req, reply) => {
    const job = db.getJob(req.params.id);
    if (!job) return reply.status(404).send({ ok: false, error: 'Job not found' });
    const pausesFile = path.join(path.dirname(job.output_dir || ''), 'pauses.json');
    let pauses: any[] = [];
    if (fs.existsSync(pausesFile)) {
      try { pauses = JSON.parse(fs.readFileSync(pausesFile, 'utf-8')); } catch { pauses = []; }
    }
    return { ok: true, data: pauses };
  });

  // POST /api/jobs/:id/pauses — Store + inject manual pauses
  // Body: { pauses: PausePoint[], protocol?: 'moonraker'|'bambu' }
  // Side effects:
  //   - Writes pauses.json sidecar next to job output
  //   - Regenerates <name>.paused.gcode with pause blocks injected
  //   - Returns { pausedGcode: filename }
  app.post<{ Params: { id: string } }>('/api/jobs/:id/pauses', async (req, reply) => {
    const job = db.getJob(req.params.id);
    if (!job) return reply.status(404).send({ ok: false, error: 'Job not found' });
    if (!job.output_dir) return reply.status(400).send({ ok: false, error: 'No output dir' });
    if (job.status !== 'completed') {
      return reply.status(400).send({ ok: false, error: 'Job not completed' });
    }

    const body = req.body as { pauses: any[]; protocol?: string };
    const pauses = Array.isArray(body?.pauses) ? body.pauses.filter(p =>
      p && typeof p === 'object' && typeof p.layer === 'number' && p.layer >= 0
    ) : [];

    // Resolve protocol: body > job's printer > default moonraker
    let protocol = body?.protocol as 'moonraker' | 'bambu' | undefined;
    if (!protocol) {
      if (job.printer_id) {
        const printer = db.getPrinter(job.printer_id);
        if (printer?.protocol) protocol = printer.protocol as 'moonraker' | 'bambu';
      }
    }
    if (!protocol || !['moonraker', 'bambu'].includes(protocol)) {
      protocol = 'moonraker';
    }

    const workDir = path.dirname(job.output_dir);
    const pausesFile = path.join(workDir, 'pauses.json');
    fs.writeFileSync(pausesFile, JSON.stringify(pauses, null, 2));

    const gcodePath = findGcodeFile(job.output_dir);
    if (!gcodePath) return reply.status(400).send({ ok: false, error: 'No gcode file' });

    // Remove stale paused sidecar when pauses cleared
    const { injectPauses, pausedGcodePath } = await import('../services/gcode-pauses.js');
    const pausedPath = pausedGcodePath(gcodePath);
    if (fs.existsSync(pausedPath)) fs.unlinkSync(pausedPath);

    if (pauses.length > 0) {
      const outPath = await injectPauses(gcodePath, pauses, { protocol });
      return { ok: true, data: { pausedGcode: path.basename(outPath), count: pauses.length } };
    }
    return { ok: true, data: { pausedGcode: null, count: 0 } };
  });

  // POST /api/jobs/:id/cancel — Cancel a job
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req, reply) => {
    const job = db.getJob(req.params.id);
    if (!job) {
      return reply.status(404).send({ ok: false, error: 'Job not found' });
    }

    if (job.status !== 'running' && job.status !== 'queued') {
      return reply.status(400).send({ ok: false, error: `Cannot cancel job in status: ${job.status}` });
    }

    try {
      const queue = getQueue();
      const bullJob = await queue.getJob(req.params.id);
      if (bullJob) await bullJob.discard();
    } catch {
      // Queue not available (direct mode) — fall through to executor cancel.
    }

    // Abort the in-flight slice directly. This works in both queue mode and
    // direct (no-Redis) mode. Without it, cancelling a running slice only
    // discarded the queued BullMQ job — the actual slicer kept running.
    runningExecutors.get(req.params.id)?.cancel();

    db.updateJobStatus(req.params.id, 'cancelled');
    return { ok: true };
  });

  // DELETE /api/jobs/:id — Delete a job
  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = db.getJob(req.params.id);
    if (!job) {
      return reply.status(404).send({ ok: false, error: 'Job not found' });
    }

    if (job.output_dir) {
      const workDir = path.dirname(job.output_dir);
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }

    return { ok: true };
  });
}

/**
 * Run slicing directly without Redis/BullMQ.
 * Executes async — the HTTP response returns immediately with the jobId.
 * Client polls GET /api/jobs/:id for progress.
 */
/**
 * Core slice worker. Same code path for direct (no Redis) and BullMQ paths.
 * Throws on failure — caller is responsible for marking job failed.
 */
/**
 * Build the input 3MF buffer that snorcal dispatches to the slicer.
 * Pure (no job state, no workDir writes) — shared by `runSliceJob` (which
 * then invokes the slicer) and `POST /api/files/preview-3mf` (which
 * returns the buffer straight to the caller without slicing, for testing
 * in OrcaSlicer / bambuddy UI / BambuStudio directly).
 */
export async function buildSliceInput3MF(
  body: SliceRequest,
  db: Db,
  modelFilePath: string,
): Promise<Buffer> {
  // Build project settings — neutral template baseline + profile overlays + user customizations.
  // Bambuddy parity: NO Snapmaker-specific overrides. The previous
  // PROJECT_SETTING_OVERRIDES slam (printer_model='Snapmaker U1', SnapSpeed
  // temps, Snapmaker printable_area, etc.) polluted EVERY 3MF regardless of
  // user-selected machine profile, and bambuddy's UI read the hardcoded
  // printer_model from project_settings.config ("Snapmaker U1" even with
  // P1S selected). Profile stub uploads (v0.1.19) carry printer_model via
  // --load-settings; user profile JSON overlays carry per-printer settings.
  const projectSettings: Record<string, unknown> = {
    ...(defaultProjectSettingsRaw as Record<string, unknown>),
  };

  // Detect printer protocol to choose the right machine start/end gcode.
  // The default-project-settings.json end gcode is Bambu-specific (M620 AMS
  // retract, M1002 judge_flag, M17 motor current) — harmless on Bambu firmware
  // but wrong/ignored on Klipper. Klipper printers (Snapmaker U1, Voron, etc.)
  // need simpler gcode that just lowers Z, moves the head, and turns off heaters.
  const printerProtocol = (() => {
    if (body.printerId) {
      const p = db.getPrinter(body.printerId);
      if (p?.protocol) return p.protocol;
    }
    // No printer selected — default to bambu (most users run Bambu
    // firmware). Previously defaulted to 'moonraker', which forced the
    // Klipper-style machine_start_gcode template below onto Bambu users
    // and made OrcaSlicer reject the `{first_layer_bed_temperature}`
    // placeholder as a vector reference (exit 156).
    return 'bambu';
  })();
  if (printerProtocol === 'moonraker') {
    // OrcaSlicer's gcode-template parser validates placeholders against
    // a known variable list + rejects vector vars used in scalar context
    // (exit 156). Two prior pitfalls:
    //   1. {first_layer_bed_temperature} / {first_layer_temperature} are
    //      VECTORS in multi-filament contexts → must use [0] index.
    //   2. {bed_depth} is NOT a valid OrcaSlicer placeholder → "Not a
    //      variable name" error. Drop the front-left move entirely;
    //      G28 + Z-lift is enough for park-at-end behavior.
    projectSettings['machine_end_gcode'] =
      'M400 ; wait for buffer to clear\n'
      + 'G91 ; relative positioning\n'
      + 'G1 Z10 F600 ; lift nozzle\n'
      + 'G90 ; absolute positioning\n'
      + 'M104 S0 ; turn off hotend\n'
      + 'M140 S0 ; turn off bed\n'
      + 'M106 S0 ; turn off fan\n'
      + 'M84 ; disable motors\n';
    projectSettings['machine_start_gcode'] =
      'M140 S{first_layer_bed_temperature[0]} ; set bed temp\n'
      + 'M104 S{first_layer_temperature[0]} ; set hotend temp\n'
      + 'G28 ; home all axes\n'
      + 'G1 Z5 F5000 ; lift nozzle\n';
  }

  // Merge selected profiles (machine → filament → process)
  if (body.profiles) {
    const engine = body.engine;
    for (const type of ['machine', 'filament', 'process'] as const) {
      const profileName = body.profiles[type];
      if (!profileName) continue;
      const profile = db.getProfile(engine, type, profileName);
      if (!profile) continue;
      try {
        const profileSettings = JSON.parse(profile.settings) as Record<string, unknown>;
        // Profile JSON files contain Preset.hpp fields (metadata like
        // setting_id, compatible_printers, description, instantiations,
        // renamed_from, version, inherits, etc) that identify the preset
        // itself and are NOT project_settings keys. Embedding them
        // pollutes project_settings.config with scalars where the slicer
        // expects arrays (filament_id vs filament_ids, etc) → array-index
        // OOB → SIGSEGV. Whitelist approach: only override keys the
        // template already has AND skip Preset.hpp self-identification
        // fields (name, from, inherits, version, type) which the template
        // carries as project-internal markers (`name="project_settings"`,
        // `from="project"`) that must NOT be overwritten with profile-
        // specific values.
        const PROFILE_SELF_KEYS = new Set([
          'type', 'name', 'inherits', 'from', 'version',
        ]);
        for (const [key, val] of Object.entries(profileSettings)) {
          if (PROFILE_SELF_KEYS.has(key)) continue;
          if (!(key in projectSettings)) continue;
          if (val === null) continue;
          // Bambu filament/process profiles store per-extruder arrays of
          // length 1-2 (per-filament overrides). Project template (cloned
          // from reference BambuStudio export) carries full AMS-slot arrays
          // (often length 4). Overwriting template with the shorter profile
          // array TRUNCATES it — the slicer then array-indexes past the end
          // → SIGSEGV in load_nozzle_infos_with_compatibility. Pad profile
          // value to template length by CYCLING the source pattern (matches
          // BambuStudio's own 2-filament → 4-AMS-slot expansion: [a,b] →
          // [a,b,a,b], not [a,b,b,b]).
          const existing = projectSettings[key];
          if (Array.isArray(val) && Array.isArray(existing) && existing.length > val.length) {
            const padded: unknown[] = [];
            const src = val as unknown[];
            for (let i = 0; i < (existing as unknown[]).length; i++) {
              padded.push(src[i % src.length]);
            }
            projectSettings[key] = padded;
          } else {
            projectSettings[key] = val;
          }
        }
      } catch {
        // Skip unparseable profile
      }
    }
  }

  // Multi-material: load second filament profile and expand arrays
  if (body.multiMaterial?.enabled) {
    const profile0Name = body.profiles?.filament;
    const profile1Name = body.profiles?.filament2;
    let profile0Settings: Record<string, unknown> | null = null;
    let profile1Settings: Record<string, unknown> | null = null;

    if (profile0Name) {
      const p = db.getProfile(body.engine, 'filament', profile0Name);
      if (p) try { profile0Settings = JSON.parse(p.settings); } catch {}
    }
    if (profile1Name) {
      const p = db.getProfile(body.engine, 'filament', profile1Name);
      if (p) try { profile1Settings = JSON.parse(p.settings); } catch {}
    }

    mergeFilamentProfiles(projectSettings, profile0Settings, profile1Settings, body.multiMaterial);
  }

  // Apply the user's per-slot filament choices (colour, type, metadata).
  // This runs for ALL slot counts (including single-filament) so that a
  // user who picks "PETG" on a 3MF originally sliced for PLA actually gets
  // PETG temperatures — OrcaSlicer reads nozzle_temperature from
  // project_settings, not from the filament_type string, so we must also
  // override the temperature when the type changes.
  // Capture the ORIGINAL embedded filament_type before overriding —
  // overrideNozzleTemps (called below) needs to know if the user changed it.
  const originalFilamentTypes = Array.isArray(projectSettings['filament_type'])
    ? [...(projectSettings['filament_type'] as string[])]
    : [];
  if (body.filamentSlots && body.filamentSlots.length > 0) {
    const slots = body.filamentSlots;

    projectSettings['filament_colour'] = slots.map(s => s.color);
    // Filament type: prefer the material encoded in the user's picked
    // profile name (e.g. "SUNLU PETG @BBL X1C" → "PETG"). Older slots set
    // only slot.profile without updating slot.type, so slot.type carried the
    // stale PLA default from the embedded 3MF and the slicer read
    // filament_type=PLA while honoring PETG temps via the profile. Profile
    // name is authoritative since it's what the user actually picked.
    projectSettings['filament_type'] = slots.map(s => {
      const fromProfile = s.profile ? deriveMaterialFromProfileName(s.profile) : null;
      const result = fromProfile ?? s.type ?? 'PLA';
      console.log(`[slice] slot.type=${s.type ?? '<none>'} profile=${s.profile ?? '<none>'} → filament_type=${result}`);
      return result;
    });
    // Propagate rich filament metadata (extracted at 3MF load) into the slice
    // 3MF so the slicer and downstream tools see vendor/density/diameter/cost.
    // Defaults match the slicer template when a slot lacks the field.
    projectSettings['filament_vendor'] = slots.map(s => s.vendor ?? '');
    projectSettings['filament_diameter'] = slots.map(s => s.diameter ?? '1.75');
    projectSettings['filament_density'] = slots.map(s => s.density ?? '1.26');
    projectSettings['filament_cost'] = slots.map(s => s.cost ?? '0');

    // Override nozzle temperatures from the DB filament profile when the
    // user's chosen type differs from the original embedded one. OrcaSlicer
    // reads nozzle_temperature as a top-level scalar (not filament_*), so
    // the type override above alone doesn't fix the temp. Without this, a
    // 3MF originally sliced for PLA (200°C) keeps 200°C even when the user
    // picks PETG — leading to under-extrusion / failed prints.
    // (Called later, after default_filament_profile is set, so the override
    // can resolve the selected profile's nozzle_temperature via inherits.)
  }

  if (body.settings?.process) {
    for (const [key, val] of Object.entries(body.settings.process)) {
      // filament_* keys belong to the filament category, not process. The
      // frontend's settings state carries them as a side effect of the
      // "Apply embedded settings" overlay (handleSourceSettings pours
      // the entire 3MF blob into `settings`, including
      // filament_type / filament_colour arrays from the embedded config).
      // Letting them ride back here overwrites the per-slot filament_type
      // derivation above (slot.profile-derived PETG) with the stale
      // embedded PLA value, so the slicer ends up with
      // filament_settings_id=SUNLU PETG + filament_type=PLA → prints as
      // PLA. filament_colour + filament_type are already set from
      // filamentSlots above; skip them here.
      if (key.startsWith('filament_')) continue;
      // Identity keys: set below from body.profiles (machine/process/
      // filament selections). Embedded 3MFs often carry empty strings or
      // stale values for these (e.g. imported P1S 3MF after switching to
      // U1), and frontend's settings state propagates them. Letting them
      // through here clobbers the correct profile-derived values.
      if (key === 'printer_model'
        || key === 'printer_settings_id'
        || key === 'print_settings_id'
        || key === 'default_print_profile'
        || key === 'default_filament_profile'
        || key === 'inherits_group'
        // Bed dimensions derive from the resolved printer profile, never the
        // imported 3MF (cross-printer imports carry source-printer bed size).
        || key === 'printable_area'
        || key === 'printable_height') continue;
      // Skip empty strings — the embedded blob frequently stores unused
      // keys as "" (e.g. curr_bed_type on some imports). Overwriting a
      // meaningful value with "" silently resets it.
      if (typeof val === 'string' && val.trim() === '') continue;
      // Frontend's "Apply embedded settings" path (App.tsx:1126) stringifies
      // arrays via JSON.stringify so they fit Record<string,string>. Reverse
      // it here: any incoming string that JSON-parses to an array becomes a
      // real array again. Without this, OrcaSlicer's load_from_json rejects
      // the whole project_settings.config ("Invalid value for parameter X:
      // [\"0\"]") for keys it expects as ConfigOptionBools/Strings arrays
      // (activate_air_filtration, activate_chamber_temp_control, fan_min_speed,
      // close_fan_the_first_x_layers, …), falls back to the 200x200 default
      // bed, and the model doesn't fit → exit 206 with no stderr. Keys the
      // template already carries as arrays are rehydrated unconditionally;
      // for keys absent from the template (e.g. activate_chamber_temp_control)
      // the shape-based JSON-array check still fires.
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              projectSettings[key] = parsed.map(String);
              continue;
            }
          } catch {
            // Not valid JSON (e.g. "[3 x 1.2mm]" coordinate) — keep scalar.
          }
        }
      }
      projectSettings[key] = String(val);
    }
  }

  // Bambuddy parity: preset identity keys (printer_settings_id,
  // print_settings_id, filament_settings_id, master_extruder_id,
  // filament_map, filament_map_mode) ship in the BambuStudio reference
  // template (default-project-settings.json) with values that match real
  // bundled slicer presets. Override them ONLY when the user explicitly
  // picks different profiles via body.profiles / body.filamentSlots —
  // unconditional overrides with hardcoded fallbacks (the v0.1.26 bug)
  // rewrote `print_settings_id` from the template's valid
  // `0.20mm Standard @BBL X1C` to a non-existent `0.20mm Standard @BBL P1S`
  // (BambuStudio ships no such process preset — P1S uses X1C). The slicer
  // failed to resolve the named preset → null deref → SIGSEGV after
  // orientation analysis.
  if (body.profiles?.machine) {
    projectSettings['printer_settings_id'] = body.profiles.machine;
    // printer_model is what OrcaSlicer keys bed dimensions off when no
    // named printer_settings_id preset is resolvable (e.g. user picked a
    // custom profile that's a stub). Without it, slicer falls back to
    // projectSettings.printable_area carried over from the imported 3MF —
    // for cross-printer imports (e.g. A1mini 180x180 source re-sliced on
    // P1S 256x256 target), the stale bed size rejects objects that fit
    // the target printer ("plate 1: Nothing to be sliced, no object is
    // fully inside the print volume", exit 206).
    projectSettings['printer_model'] = body.profiles.machine;
  }
  // Bed dimensions must always come from the resolved printer profile, never
  // from the imported 3MF. Source 3MFs carry the original author's bed size
  // (often a smaller printer than the user's target) and that bleeds through
  // to the slicer, which then rejects objects that overflow the stale bed.
  // The bundled printer profile (loaded via printer_settings_id above, or
  // OrcaSlicer's default if unset) supplies correct printable_area +
  // printable_height for the target printer.
  delete projectSettings['printable_area'];
  delete projectSettings['printable_height'];
  const filamentNames: string[] = (body.filamentSlots && body.filamentSlots.length > 0)
    ? body.filamentSlots.map(s => s.profile).filter((n): n is string => !!n)
    : (body.profiles?.filament ? [body.profiles.filament] : []);
  if (filamentNames.length > 0) {
    const colourCount = Array.isArray(projectSettings['filament_colour'])
      ? (projectSettings['filament_colour'] as string[]).length
      : 1;
    while (filamentNames.length < colourCount) {
      filamentNames.push(filamentNames[filamentNames.length - 1]);
    }
    projectSettings['filament_settings_id'] = filamentNames;
    projectSettings['default_filament_profile'] = [filamentNames[0]];
  }

  // Override nozzle temperatures when the user's chosen filament type differs
  // from the original embedded one. Resolves the selected filament profile's
  // nozzle_temperature through its inherits chain. Must run AFTER
  // default_filament_profile is set above so it can find the profile name.
  if (body.filamentSlots && body.filamentSlots.length > 0) {
    overrideNozzleTemps(projectSettings, body.filamentSlots, originalFilamentTypes, body.engine, db);
  }

  // Bambuddy parity: NO post-user-settings padding / printer_model rewrite.
  // Previous block padded nozzle_diameter, extruder_colour, extruder_offset,
  // extruder_type, nozzle_volume_type to a hardcoded targetCount (5 for U1)
  // and rewrote "Bambu Lab ..." printer_model to "Snapmaker J1/U1" to bypass
  // AMS dispatch. That diverged from bambuddy's flow (which preserves the
  // source 3MF + uploaded profile stubs and lets --load-settings drive the
  // printer model + extruder count) and correlated with multi-color
  // segfaults on both bambu + orca sidecars. The uploaded profile stubs
  // (Phase v0.1.19) + per-slot filament_colour/type set in expandFilamentSlots
  // are sufficient — let the slicer's bundled printer profile carry the rest.

  // Resolve models — support multi-model or single-model requests
  let buildModels: ThreeMFModelInput[];

  const modelIdToIndex = new Map<string, number>();
  const parentModelIds: (string | undefined)[] = [];

  if (body.models && body.models.length > 0) {
    const visibleEntries = body.models.filter((entry: any) => entry.visible !== false);
    const modelEntries = visibleEntries.filter((e: any) => !e.kind || e.kind === 'model');
    const inlineChildEntries = visibleEntries.filter((e: any) => e.kind && e.kind !== 'model');

    const rawEntries = modelEntries
      .map((entry: any, mi: number) => {
      const rec = db.getModel(entry.modelId);
      const plateIndex = (body.plateIndex && body.plateIndex > 0) ? body.plateIndex : 1;
      let stlPath = rec?.file_path ?? '';
      let faceColors: Uint8Array | undefined;
      const plate = db.getPlate(entry.modelId, plateIndex);
      if (plate) {
        stlPath = plate.file_path;
        faceColors = plate.face_colors ? new Uint8Array(plate.face_colors) : undefined;
      } else if (rec) {
        faceColors = rec.face_colors ? new Uint8Array(rec.face_colors) : undefined;
      }
      if (entry.modelId) modelIdToIndex.set(entry.modelId, mi);
      parentModelIds[mi] = entry.modelId;
      const { linkedTo: linkedToIds, ...rest } = entry;
      return {
        ...rest,
        stlPath,
        faceColors,
        name: entry.name ?? rec?.name ?? `model_${mi}`,
        _linkedToIds: linkedToIds,
      } as ThreeMFModelInput & { _linkedToIds?: string[] };
    });
    buildModels = rawEntries.map(({ _linkedToIds, ...rest }) => {
      if (_linkedToIds && _linkedToIds.length > 0) {
        for (const id of _linkedToIds) {
          const idx = modelIdToIndex.get(id);
          if (idx != null) { rest.linkedTo = idx; break; }
        }
      }
      return rest;
    });

    const plateIndexForInline = (body.plateIndex && body.plateIndex > 0) ? body.plateIndex : 1;
    const inlineResolved: (ThreeMFModelInput & { _linkedToIds?: string[] })[] = [];
    const parentsWithInlineChildren = new Set<string>();
    for (const child of inlineChildEntries) {
      let stlPath = '';
      let faceColors: Uint8Array | undefined;
      if (child.printablePartRef) {
        const ref = child.printablePartRef;
        const printableParts = db.listPrintableParts(ref.parentModelId, ref.plate);
        const pp = printableParts.find(p => p.part_index === ref.part);
        if (pp) {
          stlPath = pp.file_path;
          if (pp.face_colors) faceColors = new Uint8Array(pp.face_colors);
        }
      } else if (child.negativePartRef) {
        const ref = child.negativePartRef;
        const negParts = db.listNegativeParts(ref.parentModelId, ref.plate);
        const np = negParts.find(p => p.part_index === ref.part);
        if (np) stlPath = np.file_path;
      } else if (child.modelId) {
        const rec = db.getModel(child.modelId);
        const plate = db.getPlate(child.modelId, plateIndexForInline);
        stlPath = plate?.file_path ?? rec?.file_path ?? '';
      }
      if (child.linkedTo) {
        for (const pid of child.linkedTo) parentsWithInlineChildren.add(pid);
      }
      const { linkedTo: linkedToIds, ...rest } = child;
      inlineResolved.push({
        ...rest,
        stlPath,
        faceColors,
        _linkedToIds: linkedToIds,
      } as ThreeMFModelInput & { _linkedToIds?: string[] });
    }
    const inlineWithIndices = inlineResolved.map(({ _linkedToIds, ...rest }) => {
      if (_linkedToIds && _linkedToIds.length > 0) {
        for (const id of _linkedToIds) {
          const idx = modelIdToIndex.get(id);
          if (idx != null) { rest.linkedTo = idx; break; }
        }
      }
      return rest;
    });
    if (inlineWithIndices.length > 0) {
      buildModels = [...buildModels, ...inlineWithIndices];
    }

    const plateIndexForNegatives = (body.plateIndex && body.plateIndex > 0) ? body.plateIndex : 1;
    const negativeChildren: ThreeMFModelInput[] = [];
    const seenParentIds = new Set<string>();
    for (let pi = 0; pi < parentModelIds.length; pi++) {
      const parentModelId = parentModelIds[pi];
      if (!parentModelId) continue;
      if (seenParentIds.has(parentModelId)) continue;
      seenParentIds.add(parentModelId);
      if (parentsWithInlineChildren.has(parentModelId)) continue;
      const negParts = db.listNegativeParts(parentModelId, plateIndexForNegatives);
      negParts.forEach((np, ni) => {
        negativeChildren.push({
          stlPath: np.file_path,
          kind: 'negative',
          linkedTo: pi,
          name: `negative_${pi + 1}_${ni + 1}`,
        });
      });
    }
    if (negativeChildren.length > 0) {
      buildModels = [...buildModels, ...negativeChildren];
    }
  } else {
    const modelRecord = db.getModel(body.modelId!);
    const plateIndex = (body.plateIndex && body.plateIndex > 0) ? body.plateIndex : 1;
    let stlPath = modelFilePath || modelRecord?.file_path || '';
    let faceColors: Uint8Array | undefined;
    const plate = db.getPlate(body.modelId!, plateIndex);
    if (plate) {
      stlPath = plate.file_path;
      faceColors = plate.face_colors ? new Uint8Array(plate.face_colors) : undefined;
    } else if (modelRecord) {
      faceColors = modelRecord.face_colors ? new Uint8Array(modelRecord.face_colors) : undefined;
    }
    buildModels = [{ stlPath, faceColors, rotation: body.rotation, positionOffset: body.positionOffset }];
    parentModelIds[0] = body.modelId;

    const plateIndexForNegatives = (body.plateIndex && body.plateIndex > 0) ? body.plateIndex : 1;
    const negParts = db.listNegativeParts(body.modelId!, plateIndexForNegatives);
    negParts.forEach((np, ni) => {
      buildModels.push({
        stlPath: np.file_path,
        kind: 'negative',
        linkedTo: 0,
        name: `negative_1_${ni + 1}`,
      });
    });
  }

  // Normalize values that BambuStudio exports as "inherit/auto" sentinels
  // but that OrcaSlicer CLI rejects at range validation, and that both
  // sidecars can trip over during multi-color slicing.
  //
  //   - "-1" sentinel (inherit-from-parent in BambuStudio GUI)  → "0"
  //     Affects: raft_first_layer_expansion, tree_support_wall_count,
  //     prime_tower_lift_height, filament_ramming_volumetric_speed[*],
  //     ironing_fan_speed[*], and others in user-imported 3MFs.
  //   - "*_filament": "0" (BambuStudio "unset" marker, range wants >= 1) → "1"
  //     Affects: solid_infill_filament, sparse_infill_filament, wall_filament,
  //     support_filament, support_interface_filament.
  //
  // Verified against OrcaSlicer 2.4 + BambuStudio 02.07 sidecar range checks
  // (exit 238 with `raft_first_layer_expansion: -1 not in range [0, MAX]`
  //  + `solid_infill_filament: 0 not in range [1, MAX]`).
  sanitizeSentinelsAndZeroFilaments(projectSettings, body.engine);

  return build3MF({
    models: buildModels,
    projectSettings,
    buildVolume: body.buildVolume,
    engine: body.engine,
  });
}

/**
 * Mutates `settings` in place: replaces "-1" sentinel values (BambuStudio
 * inherit-from-parent marker) with "0", and `*_filament: "0"` (BambuStudio
 * unset marker — slicer range wants >= 1) with "1". Handles arrays.
 *
 * OrcaSlicer CLI rejects these outright (exit 238). BambuStudio tolerates
 * them in its own GUI exports but snorcal's HTTP-upload path can still trip
 * the slicer downstream. Safer to normalize universally.
 *
 * Replaces v0.1.20's narrower 3-key strip and v0.1.28's "keep sentinels"
 * decision (the latter was based on the assumption that bambuddy sidecar
 * strips them upstream — it does NOT for the sync /slice path snorcal uses).
 */
function sanitizeSentinelsAndZeroFilaments(settings: Record<string, unknown>, engine?: string): void {
  const fixScalar = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    if (v === '-1') return '0';
    return v;
  };
  for (const [key, val] of Object.entries(settings)) {
    if (Array.isArray(val)) {
      settings[key] = val.map(fixScalar);
      continue;
    }
    if (typeof val === 'string') {
      if (val === '-1') {
        settings[key] = '0';
      } else if (val === '0' && key.endsWith('_filament')) {
        settings[key] = '1';
      }
    }
  }
  // Strip compatibility-list fields. These are preset-store hints used by the
  // slicer to gate "process X compatible with printer Y" checks when settings
  // are loaded from named system presets. Snorcal embeds full resolved
  // settings inline, so the check is redundant AND actively harmful when the
  // user picks a printer whose model isn't in a list inherited from default
  // profiles (e.g. Snapmaker U1 not in default `print_compatible_printers`
  // Bambu-only list → exit 239 "process not compatible with printer").
  delete settings.print_compatible_printers;
  delete settings.compatible_printers;
  delete settings.compatible_printers_condition;
  delete settings.upward_compatible_machine;

  // Force-clear inherits_group — OrcaSlicer/BambuStudio load named library
  // presets via this key and overlay their values on top of the embedded
  // project_settings, overriding snorcal's resolved values (filament_colour,
  // filament_settings_id, etc). Pad/truncate to match filament_colour length
  // so array stays consistent.
  const fg = settings.inherits_group;
  if (Array.isArray(fg)) {
    settings.inherits_group = fg.map(() => '');
  } else if (fg !== undefined) {
    settings.inherits_group = [''];
  }

  // Clear preset-identity fields so the slicer doesn't try to resolve named
  // system presets. Snorcal embeds full resolved settings inline, so named
  // lookups are redundant AND can fail when the user-selected printer isn't
  // in the slicer's bundled vendor folder (exit 1). filament_settings_id is
  // left alone because it carries per-slot identity used by the slicer's
  // filament-output naming.
  settings.printer_settings_id = '';
  settings.print_settings_id = '';
  settings.printer_model = '';

  // OrcaSlicer/BambuStudio exit 205: "Ooze prevention is only supported with
  // the wipe tower when 'single_extruder_multi_material' is off". Error fires
  // whenever ooze_prevention=1 AND single_extruder_multi_material=1, regardless
  // of prime tower state. User-imported profiles can drag ooze_prevention=1 in
  // even though snorcal defaults to 0. Force off universally — snorcal never
  // emits the AMS-only ooze-prevention mode that would make this useful.
  settings.ooze_prevention = '0';

  // OrcaSlicer/BambuStudio exit 205 (second variant): "Relative extruder
  // addressing requires resetting the extruder position at each layer to
  // prevent loss of floating point accuracy. Add 'G92 E0' to layer_gcode."
  // Snorcal forces use_relative_e_distances=1, so the slicer requires G92 E0
  // at every layer transition. Prepend to both before_layer_change_gcode and
  // layer_change_gcode (slicer checks either) unless user already has it.
  // Skip if user already wrote G92 E0 / G92E0 (case/space variants).
  const g92Pattern = /G92\s*E0/i;
  const blc = typeof settings.before_layer_change_gcode === 'string' ? settings.before_layer_change_gcode : '';
  if (!g92Pattern.test(blc)) {
    settings.before_layer_change_gcode = `G92 E0\n${blc}`.trimStart();
  }
  const lc = typeof settings.layer_change_gcode === 'string' ? settings.layer_change_gcode : '';
  if (!g92Pattern.test(lc)) {
    settings.layer_change_gcode = `G92 E0\n${lc}`.trimStart();
  }
  // Multi-material (single_extruder_multi_material=1) profiles also need
  // G92 E0 in the toolchange gcode — exit 205 fires when relative-E is on and
  // the slicer can't guarantee an extruder reset across filament swaps. Some
  // lean user-imported process profiles ship change_filament_gcode as empty.
  const semm = settings.single_extruder_multi_material;
  if (semm === '1' || semm === 1) {
    const cfg = typeof settings.change_filament_gcode === 'string' ? settings.change_filament_gcode : '';
    if (!g92Pattern.test(cfg)) {
      settings.change_filament_gcode = cfg ? `G92 E0\n${cfg}` : 'G92 E0';
    }
  }
}

export async function runSliceJob(
  jobId: string,
  body: SliceRequest,
  modelFilePath: string,
  modelName: string,
  workDir: string,
  db: Db,
  onProgress?: (progress: number, step: string) => void,
): Promise<void> {
  const executor = new SlicerExecutor();
  db.updateJobStatus(jobId, 'running');
  db.updateJobProgress(jobId, 5, 'Building 3MF...');
  onProgress?.(5, 'Building 3MF...');

  // Register the executor so the cancel route can reach it (see POST
  // /api/jobs/:id/cancel below). Cleared in the finally.
  runningExecutors.set(jobId, executor);

  try {
    const threemfBuffer = await buildSliceInput3MF(body, db, modelFilePath);

    const input3mfPath = path.join(workDir, 'input.3mf');
    fs.writeFileSync(input3mfPath, threemfBuffer);

    const outputDir = path.join(workDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    db.updateJobProgress(jobId, 15, 'Spawning slicer...');
    onProgress?.(15, 'Spawning slicer...');

      // Build bambuddy-style profile stubs from the user's picker choices.
      // Sidecar walks `inherits` against its bundled slicer presets and
      // produces full resolved profiles, passed via --load-settings /
      // --load-filaments. Per-slot filament profile names come from
      // filamentSlots (multi-color) or fallback to profiles.filament.
      const printerName = body.profiles?.machine;
      const presetName = body.profiles?.process;
      const filamentNames: string[] = (body.filamentSlots && body.filamentSlots.length > 0)
        ? body.filamentSlots.map(s => s.profile).filter((n): n is string => !!n)
        : (body.profiles?.filament ? [body.profiles.filament] : []);
      const profileStubs: {
        printer?: string;
        preset?: string;
        filaments?: string[];
      } = {};
      if (printerName) profileStubs.printer = buildProfileStub(printerName, 'machine');
      if (presetName) profileStubs.preset = buildProfileStub(presetName, 'process');
      if (filamentNames.length > 0) profileStubs.filaments = filamentNames.map(n => buildProfileStub(n, 'filament'));

      const result = await executor.execute(
        {
          engine: body.engine,
          input3mf: input3mfPath,
          outputDir,
          processSettings: '',
          machineSettings: '',
          filamentSettings: [],
          plateIndex: 0,
          workDir,
          dataDir: process.env.SLICER_DATADIR || getDefaultDataDir(body.engine),
          profileStubs: Object.keys(profileStubs).length > 0 ? profileStubs : undefined,
          binaryOverridePath: readBinaryOverride(db, body.engine),
        },
        (progress: number, step: string) => {
          const mapped = Math.max(15, Math.min(95, progress));
          db.updateJobProgress(jobId, mapped, step);
          onProgress?.(mapped, step);
        },
      );

      if (result.exitCode !== 0) {
        // Prefer stderr (OrcaSlicer emits validation messages there); widen
        // from 1000→2000 chars so longer messages aren't truncated. OrcaSlicer
        // writes some failures (config-parse rejection → bed-size fallback →
        // "Nothing to be sliced") ONLY to its --logfile, not stdout/stderr —
        // when output is empty, point at the logfile if it was kept.
        const output = (result.stderr || result.stdout).slice(-2000).trim();
        const logPath = path.join(workDir, 'slicer.log');
        const hint = !output && fs.existsSync(logPath)
          ? `\n[no stderr — see ${logPath}]`
          : '';
        throw new Error(`Slicer exited with code ${result.exitCode}: ${output}${hint}`);
      }

      db.updateJobStatus(jobId, 'completed');
      if (result.gcodeSize) db.updateJobOutput(jobId, result.gcodeSize);

      // Rename gcode to use model name
      let finalGcodePath = result.gcodePath;
      if (result.gcodePath) {
        const baseName = modelName.replace(/\.[^.]+$/, ''); // strip extension
        const gcodeName = `${baseName}.gcode`;
        const renamedPath = path.join(path.dirname(result.gcodePath), gcodeName);
        try { fs.renameSync(result.gcodePath, renamedPath); finalGcodePath = renamedPath; } catch { /* keep original name */ }
      }

      // Inject Bambu-format layer count comment into HEADER_BLOCK so P1S/X1C
      // firmware reports total_layer_num (OrcaSlicer only writes FOOTER flavor).
      if (finalGcodePath && fs.existsSync(finalGcodePath)) {
        try { injectBambuLayerCountHeader(finalGcodePath); } catch (e) {
          console.warn(`[slice ${jobId}] injectBambuLayerCountHeader failed:`, e instanceof Error ? e.message : e);
        }
      }

      // Parse estimates from gcode comments
      if (finalGcodePath && fs.existsSync(finalGcodePath)) {
        const estimates = parseGcodeEstimates(finalGcodePath, modelName);
        db.updateJobEstimates(jobId, estimates);
      }
  } catch (err) {
    // Dump diagnostic context to backend log BEFORE workDir cleanup deletes
    // evidence. OrcaSlicer exits with generic "run found error" stderr while
    // the real cause is in slicer.log (--logfile). Capture both here.
    try {
      const slicerLogPath = path.join(workDir, 'slicer.log');
      const slicerLog = fs.existsSync(slicerLogPath)
        ? fs.readFileSync(slicerLogPath, 'utf8').slice(-3000)
        : '(no slicer.log)';
      const inputPath = path.join(workDir, 'input.3mf');
      const inputInfo = fs.existsSync(inputPath)
        ? `${fs.statSync(inputPath).size} bytes`
        : 'MISSING';
      // Copy input.3mf to /tmp for inspection — OrcaSlicer "nothing to slice"
      // errors require inspecting the built 3MF (object placement, plate meta).
      if (fs.existsSync(inputPath)) {
        const tmpPath = `/tmp/snorcal-failed-${jobId}.3mf`;
        try { fs.copyFileSync(inputPath, tmpPath); console.warn(`[slice FAIL] input.3mf copied to ${tmpPath}`); } catch {}
      }
      console.error(`[slice FAIL ${jobId}]`, {
        error: err instanceof Error ? err.message : String(err),
        engine: body.engine,
        modelId: body.modelId,
        modelExists: body.modelId ? !!db.getModel(body.modelId) : 'n/a',
        plateIndex: body.plateIndex,
        modelsCount: body.models?.length,
        modelsSummary: body.models?.map((m: any) => ({ modelId: m.modelId, visible: m.visible, kind: m.kind, name: m.name })),
        inputInfo,
        slicerLogTail: slicerLog,
      });
    } catch { /* best effort */ }

    // Failure (non-zero exit, spawn error, abort from cancel, 3MF build
    // failure) — remove the workDir so failed slices don't accumulate on
    // disk. Success path keeps the dir (holds output gcode; removed later by
    // DELETE /api/jobs/:id). Mirrors models.ts clean-on-failure pattern.
    // Set SNORCAL_KEEP_FAILED_SLICE=1 to preserve for debugging.
    if (process.env.SNORCAL_KEEP_FAILED_SLICE !== '1') {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    } else {
      console.warn(`[slice] keeping failed workDir at ${workDir} (SNORCAL_KEEP_FAILED_SLICE=1)`);
    }
    throw err;
  } finally {
    runningExecutors.delete(jobId);
  }
}

/**
 * Run slicing directly without Redis/BullMQ.
 * Executes async — the HTTP response returns immediately with the jobId.
 * Client polls GET /api/jobs/:id for progress.
 */
export function runSliceDirect(
  jobId: string,
  body: SliceRequest,
  modelFilePath: string,
  modelName: string,
  workDir: string,
  db: Db,
) {
  runSliceJob(jobId, body, modelFilePath, modelName, workDir, db).catch((err) => {
    // When a slice is cancelled (executor.cancel() → fetch abort → AbortError),
    // the cancel route has already marked the job 'cancelled'. Don't overwrite
    // that with 'failed' — just log and leave the status alone.
    const isAbort = err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
    if (isAbort) {
      console.log(`[slice] job ${jobId} aborted by cancel`);
      return;
    }
    const message = err instanceof Error ? `${err.message}\n${err.stack?.slice(0, 500)}` : String(err);
    db.updateJobStatus(jobId, 'failed', { errorMessage: message });
  });
}

/**
 * Inject `; total layers count = N` into HEADER_BLOCK so Bambu firmware
 * populates `total_layer_num` for OrcaSlicer-output gcodes. OrcaSlicer only
 * writes this comment in FOOTER_BLOCK (Bambu format); Bambu firmware scans
 * HEADER_BLOCK only → reports 0 layers → UI shows "Layer 0/0" mid-print.
 * Idempotent: skips if Bambu-format comment already present in header.
 */
function injectBambuLayerCountHeader(gcodePath: string): void {
  let content: string;
  try { content = fs.readFileSync(gcodePath, 'utf-8'); } catch { return; }
  const lines = content.split('\n');

  // Resolve layer count: prefer Orca header comment, fall back to LAYER_CHANGE count.
  let layerCount: number | undefined;
  const headerEndIdx = lines.findIndex(l => l.includes('HEADER_BLOCK_END'));
  const headerScanLimit = headerEndIdx > 0 ? headerEndIdx : 200;
  for (let i = 0; i < Math.min(headerScanLimit, lines.length); i++) {
    const m = lines[i].match(/;\s*total layer number:\s*(\d+)/i);
    if (m) { layerCount = parseInt(m[1], 10); break; }
  }
  if (!Number.isFinite(layerCount as number)) {
    let changes = 0;
    for (const l of lines) if (/^;LAYER_CHANGE\b/.test(l)) changes++;
    if (changes > 0) layerCount = changes;
  }
  if (!Number.isFinite(layerCount as number) || (layerCount as number) <= 0) return;

  const startIdx = lines.findIndex(l => l.includes('HEADER_BLOCK_START'));
  const endIdx = lines.findIndex(l => l.includes('HEADER_BLOCK_END'));
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return;

  // Skip if Bambu-format comment already exists in HEADER_BLOCK (idempotent).
  // OrcaSlicer always writes it in FOOTER_BLOCK — that doesn't count.
  const headerSlice = lines.slice(startIdx, endIdx + 1);
  if (headerSlice.some(l => /;\s*total layers count\s*=/.test(l))) return;

  // Insert just before HEADER_BLOCK_END. Keep comment style Bambu-native.
  lines.splice(endIdx, 0, `; total layers count = ${layerCount}`);
  fs.writeFileSync(gcodePath, lines.join('\n'));
}

function parseGcodeEstimates(gcodePath: string, modelName: string): {
  modelName: string;
  estimatedTime?: string;
  filamentUsedG?: number;
  filamentCost?: number;
} {
  const content = fs.readFileSync(gcodePath, 'utf-8');
  const lines = content.split('\n');

  let estimatedTime: string | undefined;
  let filamentUsedG: number | undefined;
  let filamentCost: number | undefined;

  for (const line of lines) {
    if (!line.startsWith(';')) continue;
    // OrcaSlicer (current): "; model printing time: 31m; total estimated time: 37m 55s"
    // BambuStudio (legacy): "; estimated printing time (normal mode) = 37m 55s"
    if (!estimatedTime) {
      const m1a = line.match(/total estimated time:\s*(.+)/);
      if (m1a) estimatedTime = m1a[1].split(';')[0].trim();
      else {
        const m1b = line.match(/estimated printing time \(normal mode\)\s*=\s*(.+)/);
        if (m1b) estimatedTime = m1b[1].trim();
      }
    }
    // OrcaSlicer: "; filament used [g] = 5.83" (scalar) or array
    if (filamentUsedG === undefined) {
      const m2 = line.match(/filament used \[g\]\s*[:=]\s*([\d.\s,\[\]]+)/);
      if (m2) {
        // Sum array elements; for scalar, parseFloat gets the single value.
        const nums = m2[1].match(/[\d.]+/g);
        if (nums) filamentUsedG = nums.reduce((sum, s) => sum + parseFloat(s), 0);
      } else {
        const m2b = line.match(/total filament used \[g\]\s*=\s*([\d.]+)/);
        if (m2b) filamentUsedG = parseFloat(m2b[1]);
      }
    }
    // OrcaSlicer: "; filament cost = 0.09" (scalar) or array
    if (filamentCost === undefined) {
      const m3 = line.match(/filament cost\s*[:=]\s*([\d.\s,\[\]]+)/);
      if (m3) {
        const nums = m3[1].match(/[\d.]+/g);
        if (nums) filamentCost = nums.reduce((sum, s) => sum + parseFloat(s), 0);
      } else {
        const m3b = line.match(/total filament cost\s*=\s*([\d.]+)/);
        if (m3b) filamentCost = parseFloat(m3b[1]);
      }
    }
  }

  return { modelName, estimatedTime, filamentUsedG, filamentCost };
}

