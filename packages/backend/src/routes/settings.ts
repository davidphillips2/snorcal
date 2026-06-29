import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import {
  DEFAULT_PROCESS_SETTINGS,
  DEFAULT_MACHINE_SETTINGS,
  DEFAULT_FILAMENT_SETTINGS,
  getSlicerBinary,
} from '@snorcal/shared';

const VALID_TYPES = ['machine', 'filament', 'process'] as const;
type ProfileType = typeof VALID_TYPES[number];

export function detectProfileType(json: Record<string, unknown>, filename: string): ProfileType | null {
  // From JSON "type" field
  const t = String(json['type'] || '').toLowerCase();
  if (VALID_TYPES.includes(t as ProfileType)) return t as ProfileType;

  // From filename path (e.g., "machine/My Printer.json" or "OrcaSlicer_config_bundle/machine/My Printer.json")
  const lower = filename.toLowerCase();
  if (lower.includes('machine')) return 'machine';
  if (lower.includes('filament')) return 'filament';
  if (lower.includes('process') || lower.includes('print')) return 'process';

  return null;
}

export function getProfileName(json: Record<string, unknown>, filename: string): string {
  if (json['name'] && typeof json['name'] === 'string') return json['name'];
  // Strip directory path and extension
  const base = filename.split('/').pop() || filename;
  return base.replace(/\.json$/i, '');
}

export async function settingsRoutes(app: FastifyInstance, options: { db: Db }) {
  const { db } = options;

  // GET /api/settings/:engine/defaults — Get default settings
  app.get<{ Params: { engine: string } }>('/api/settings/:engine/defaults', async (req) => {
    return {
      ok: true,
      data: {
        process: DEFAULT_PROCESS_SETTINGS,
        machine: DEFAULT_MACHINE_SETTINGS,
        filaments: [DEFAULT_FILAMENT_SETTINGS],
      },
    };
  });

  // GET /api/settings/:engine/profiles — List profiles (optional ?type= filter)
  app.get<{
    Params: { engine: string };
    Querystring: { type?: string };
  }>('/api/settings/:engine/profiles', async (req) => {
    const profiles = db.listProfiles(req.params.engine, req.query.type);
    return { ok: true, data: profiles };
  });

  // GET /api/settings/:engine/profiles/:type/:name — Load a profile
  app.get<{ Params: { engine: string; type: string; name: string } }>(
    '/api/settings/:engine/profiles/:type/:name',
    async (req, reply) => {
      const profile = db.getProfile(req.params.engine, req.params.type, req.params.name);
      if (!profile) {
        return reply.status(404).send({ ok: false, error: 'Profile not found' });
      }
      return { ok: true, data: JSON.parse(profile.settings) };
    },
  );

  // PUT /api/settings/:engine/profiles/:type/:name — Save a profile
  app.put<{ Params: { engine: string; type: string; name: string } }>(
    '/api/settings/:engine/profiles/:type/:name',
    async (req) => {
      const settings = req.body;
      db.upsertProfile(req.params.engine, req.params.type, req.params.name, JSON.stringify(settings));
      return { ok: true };
    },
  );

  // DELETE /api/settings/:engine/profiles/:type/:name — Delete a profile
  app.delete<{ Params: { engine: string; type: string; name: string } }>(
    '/api/settings/:engine/profiles/:type/:name',
    async (req, reply) => {
      const profile = db.getProfile(req.params.engine, req.params.type, req.params.name);
      if (!profile) {
        return reply.status(404).send({ ok: false, error: 'Profile not found' });
      }
      db.deleteProfile(req.params.engine, req.params.type, req.params.name);
      return { ok: true };
    },
  );

  // POST /api/settings/:engine/import — Import profiles from JSON files or ZIP bundle
  app.post<{ Params: { engine: string } }>(
    '/api/settings/:engine/import',
    async (req, reply) => {
      const data = await req.file();
      if (!data) {
        return reply.status(400).send({ ok: false, error: 'No file uploaded' });
      }

      const buffer = await data.toBuffer();
      const filename = data.filename;
      const imported: { type: string; name: string }[] = [];
      const errors: { file: string; error: string }[] = [];

      const processJson = (jsonStr: string, entryName: string) => {
        try {
          const json = JSON.parse(jsonStr);
          if (typeof json !== 'object' || json === null) return;

          const profileType = detectProfileType(json as Record<string, unknown>, entryName);
          if (!profileType) {
            errors.push({ file: entryName, error: 'Could not detect profile type' });
            return;
          }

          const name = getProfileName(json as Record<string, unknown>, entryName);
          db.upsertProfile(req.params.engine, profileType, name, JSON.stringify(json));
          imported.push({ type: profileType, name });
        } catch (e) {
          errors.push({ file: entryName, error: String(e) });
        }
      };

      if (filename.endsWith('.zip')) {
        // ZIP bundle (OrcaSlicer config bundle export)
        const zip = await JSZip.loadAsync(buffer);
        for (const [path, file] of Object.entries(zip.files)) {
          if (file.dir || !path.endsWith('.json')) continue;
          const content = await file.async('text');
          processJson(content, path);
        }
      } else if (filename.endsWith('.json')) {
        processJson(buffer.toString('utf-8'), filename);
      } else {
        return reply.status(400).send({ ok: false, error: 'Unsupported file type. Upload .json or .zip files.' });
      }

      return { ok: true, data: { imported, errors } };
    },
  );

  // POST /api/settings/:engine/import-local — Scan the locally-installed
  // slicer's bundled profiles directory and bulk-import every machine /
  // process / filament preset JSON into the DB. Reuses detectProfileType +
  // getProfileName from the file-upload path. Idempotent — re-running
  // upserts over existing rows.
  //
  // Skips: vendor metadata JSONs (no `type` field, not under machine/process
  // /filament subdir), template JSONs (filename contains "template" — these
  // are gcode snippet templates, not slicable presets), and JSONs with no
  // usable name.
  app.post<{ Params: { engine: string } }>(
    '/api/settings/:engine/import-local',
    async (req, reply) => {
      const { engine } = req.params;

      let profilesRoot: string;
      try {
        profilesRoot = path.join(getSlicerBinary(engine).profilesDir, 'profiles');
      } catch {
        return reply.status(400).send({ ok: false, error: `Unknown engine: ${engine}` });
      }
      if (!fs.existsSync(profilesRoot)) {
        return reply.status(404).send({
          ok: false,
          error: `Local profiles dir not found: ${profilesRoot}. Is ${engine} installed on this host?`,
        });
      }

      const imported: { type: string; name: string }[] = [];
      const skipped: { file: string; reason: string }[] = [];
      const errors: { file: string; error: string }[] = [];

      const walk = (dir: string): string[] => {
        const out: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) out.push(...walk(full));
          else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
        }
        return out;
      };

      const files = walk(profilesRoot);
      for (const file of files) {
        const rel = path.relative(profilesRoot, file);
        // Skip gcode snippet templates — they're not slicable presets.
        if (/template/i.test(rel)) {
          skipped.push({ file: rel, reason: 'template' });
          continue;
        }
        try {
          const json = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
          if (typeof json !== 'object' || json === null) {
            skipped.push({ file: rel, reason: 'not a JSON object' });
            continue;
          }
          const type = detectProfileType(json, rel);
          if (!type) {
            skipped.push({ file: rel, reason: 'unknown type' });
            continue;
          }
          const name = getProfileName(json, rel);
          if (!name) {
            skipped.push({ file: rel, reason: 'no name' });
            continue;
          }
          db.upsertProfile(engine, type, name, JSON.stringify(json));
          imported.push({ type, name });
        } catch (e) {
          errors.push({ file: rel, error: e instanceof Error ? e.message : String(e) });
        }
      }

      const counts = imported.reduce<Record<string, number>>((acc, { type }) => {
        acc[type] = (acc[type] ?? 0) + 1;
        return acc;
      }, {});

      return {
        ok: true,
        data: {
          scanned: files.length,
          imported: counts,
          skippedCount: skipped.length,
          errorCount: errors.length,
          errors: errors.slice(0, 20), // cap to keep payload small
        },
      };
    },
  );

  // --- App-level key/value settings ---
  // Whitelist of keys the API will read/write. Keep tight — anything else 400s.
  const SETTING_KEYS = new Set(['bambu_cloud_token']);

  // GET /api/settings/key/:key — Returns { value: string | null } (token returned
  // as last-4 hint only, to avoid leaking the full secret over the wire on GET).
  app.get<{ Params: { key: string } }>('/api/settings/key/:key', async (req, reply) => {
    const { key } = req.params;
    if (!SETTING_KEYS.has(key)) {
      return reply.status(400).send({ ok: false, error: `Unknown setting key: ${key}` });
    }
    const raw = db.getSetting(key);
    const hint = raw && raw.length > 4 ? `••••${raw.slice(-4)}` : (raw ? '••••' : null);
    return { ok: true, data: { value: raw, hint } };
  });

  // PUT /api/settings/key/:key — body: { value: string }
  app.put<{ Params: { key: string } }>('/api/settings/key/:key', async (req, reply) => {
    const { key } = req.params;
    if (!SETTING_KEYS.has(key)) {
      return reply.status(400).send({ ok: false, error: `Unknown setting key: ${key}` });
    }
    const body = req.body as { value?: string };
    if (typeof body?.value !== 'string' || !body.value.trim()) {
      return reply.status(400).send({ ok: false, error: 'value required' });
    }
    db.setSetting(key, body.value.trim());
    return { ok: true };
  });
}
