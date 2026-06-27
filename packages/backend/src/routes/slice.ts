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

/** Get default slicer datadir for the current platform and engine */
function getDefaultDataDir(engine: string): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const macDirs: Record<string, string> = {
      orcaslicer: 'OrcaSlicer',
      bambustudio: 'BambuStudio',
    };
    return path.join(home, 'Library', 'Application Support', macDirs[engine] ?? 'OrcaSlicer');
  }
  // Linux (Docker)
  const linuxDirs: Record<string, string> = {
    orcaslicer: 'OrcaSlicer',
    bambustudio: 'BambuStudio',
  };
  return path.join(home, '.config', linuxDirs[engine] ?? 'OrcaSlicer');
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
  for (const key of filamentKeys) {
    if (key === 'filament_colour' || key === 'filament_type') continue; // already set
    const existing = projectSettings[key] as any[] | undefined;
    const profileFallback = profileSettings.find(p => p && p[key] !== undefined && p[key] !== '');
    const expanded = profileSettings.map((p, i) => {
      if (p && p[key] !== undefined && p[key] !== '') return String(p[key]);
      if (profileFallback) return String(profileFallback[key]);
      return existing?.[i] ?? existing?.[0] ?? '';
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

    const validEngines = ['orcaslicer', 'bambustudio'];
    if (!validEngines.includes(body.engine)) {
      return reply.status(400).send({ ok: false, error: `Invalid engine: ${body.engine}` });
    }

    const jobId = uuid();
    const workDir = path.join(getJobsDir(), jobId);
    ensureDir(workDir);

    const primaryModelId = body.modelId || body.models?.[0]?.modelId || '';
    const primaryModel = body.modelId ? db.getModel(body.modelId) : db.getModel(primaryModelId);

    db.insertJob({
      id: jobId,
      modelId: primaryModelId,
      engine: body.engine,
      settings: JSON.stringify(body.settings),
      outputDir: path.join(workDir, 'output'),
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
    // SQLite datetime('now') returns UTC "YYYY-MM-DD HH:MM:SS" with no zone
    // suffix. Frontend Date constructor treats that as local time, shifting
    // displayed time by the user's UTC offset. Append Z so it parses as UTC.
    const toIso = (s: string | null | undefined): string | null =>
      s && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : (s ?? null);
    return {
      ok: true,
      data: jobs.map((j) => ({
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
        createdAt: toIso(j.created_at),
      })),
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
      // Queue not available
    }

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
        for (const [key, val] of Object.entries(profileSettings)) {
          if (['type', 'name', 'inherits', 'from', 'version'].includes(key)) continue;
          if (val === null) continue;
          projectSettings[key] = val;
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

  // Multi-color filament slots: expand all filament_* arrays to N elements
  if (body.filamentSlots && body.filamentSlots.length > 1) {
    const profileSettings: (Record<string, unknown> | null)[] = body.filamentSlots.map((slot) => {
      if (!slot.profile) return null;
      const p = db.getProfile(body.engine, 'filament', slot.profile);
      if (!p) return null;
      try { return JSON.parse(p.settings) as Record<string, unknown>; } catch { return null; }
    });
    expandFilamentSlots(projectSettings, body.filamentSlots, profileSettings);
  }

  if (body.settings?.process) {
    for (const [key, val] of Object.entries(body.settings.process)) {
      projectSettings[key] = String(val);
    }
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
    let stlPath = modelFilePath;
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

  // Strip "-1" sentinel values from projectSettings before embedding. The
  // slicer CLI's StaticPrintConfig range validator rejects "-1" with
  // "<field>: -1 not in range [...]" → "input preset file is invalid" on
  // Bambu. Mirrors bambuddy's _sanitize_project_settings_sentinels
  // (library.py:3062-3112) + _PROJECT_SETTINGS_SENTINEL_KEYS allowlist
  // (library.py:3050-3059) exactly.
  const SENTINEL_KEYS = new Set([
    'raft_first_layer_expansion',
    'tree_support_wall_count',
    'prime_tower_brim_width',
  ]);
  for (const k of SENTINEL_KEYS) {
    if (projectSettings[k] === '-1' || projectSettings[k] === -1) delete projectSettings[k];
  }

  return build3MF({
    models: buildModels,
    projectSettings,
    buildVolume: body.buildVolume,
  });
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
        },
        (progress: number, step: string) => {
          const mapped = Math.max(15, Math.min(95, progress));
          db.updateJobProgress(jobId, mapped, step);
          onProgress?.(mapped, step);
        },
      );

      if (result.exitCode !== 0) {
        const output = (result.stdout + '\n' + result.stderr).slice(-1000);
        throw new Error(`Slicer exited with code ${result.exitCode}: ${output}`);
      }

      db.updateJobStatus(jobId, 'completed');
      if (result.gcodeSize) db.updateJobOutput(jobId, result.gcodeSize);

      // Rename gcode to use model name
      if (result.gcodePath) {
        const baseName = modelName.replace(/\.[^.]+$/, ''); // strip extension
        const gcodeName = `${baseName}.gcode`;
        const renamedPath = path.join(path.dirname(result.gcodePath), gcodeName);
        try { fs.renameSync(result.gcodePath, renamedPath); } catch { /* keep original name */ }
      }

      // Parse estimates from gcode comments
      if (result.gcodePath && fs.existsSync(result.gcodePath)) {
        const estimates = parseGcodeEstimates(result.gcodePath, modelName);
        db.updateJobEstimates(jobId, estimates);
      } else if (result.gcodePath) {
        // Check renamed path
        const renamed = path.join(path.dirname(result.gcodePath), `${modelName.replace(/\.[^.]+$/, '')}.gcode`);
        if (fs.existsSync(renamed)) {
          const estimates = parseGcodeEstimates(renamed, modelName);
          db.updateJobEstimates(jobId, estimates);
        }
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
    const message = err instanceof Error ? `${err.message}\n${err.stack?.slice(0, 500)}` : String(err);
    db.updateJobStatus(jobId, 'failed', { errorMessage: message });
  });
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

