import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import JSZip from 'jszip';
import type { Db } from '../db/index.js';
import {
  DEFAULT_PROCESS_SETTINGS,
  DEFAULT_MACHINE_SETTINGS,
  DEFAULT_FILAMENT_SETTINGS,
} from '@snorcal/shared';

const VALID_TYPES = ['machine', 'filament', 'process'] as const;
type ProfileType = typeof VALID_TYPES[number];

function detectProfileType(json: Record<string, unknown>, filename: string): ProfileType | null {
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

function getProfileName(json: Record<string, unknown>, filename: string): string {
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
}
