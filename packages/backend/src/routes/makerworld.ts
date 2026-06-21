import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { register3MFModel } from './models.js';
import {
  parseUrl,
  getDesign,
  listInstances,
  getSignedDownloadUrl,
  download3mf,
  fetchThumbnail,
  extractProjectSettings,
  bambuLogin,
  MakerWorldError,
  MakerWorldAuthError,
  MakerWorldForbiddenError,
  MakerWorldNotFoundError,
  MakerWorldUrlError,
} from '../services/makerworld.js';

function mwErrorStatus(e: unknown): number {
  if (e instanceof MakerWorldAuthError) return 401;
  if (e instanceof MakerWorldForbiddenError) return 403;
  if (e instanceof MakerWorldNotFoundError) return 404;
  if (e instanceof MakerWorldUrlError) return 400;
  return 502;
}

function mwErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function makerworldRoutes(app: FastifyInstance, options: { db: Db }) {
  const { db } = options;

  // POST /api/makerworld/resolve { url }
  // Returns metadata + plate list. Anonymous (no token required).
  app.post<{ Body: { url?: string } }>('/api/makerworld/resolve', async (req, reply) => {
    const url = req.body?.url;
    if (!url || typeof url !== 'string') {
      return reply.status(400).send({ ok: false, error: 'url required' });
    }

    try {
      const parsed = parseUrl(url);
      const [design, instances] = await Promise.all([
        getDesign(parsed.numericModelId),
        listInstances(parsed.numericModelId),
      ]);

      return {
        ok: true,
        data: {
          numericId: parsed.numericModelId,
          alphanumericId: design.alphanumericId,
          title: design.title,
          creator: design.creatorName,
          coverUrl: design.coverUrl,
          summary: design.summary,
          instances,
          profileId: parsed.profileId,
        },
      };
    } catch (e) {
      return reply.status(mwErrorStatus(e)).send({ ok: false, error: mwErrorMessage(e) });
    }
  });

  // POST /api/makerworld/import { numericId, alphanumericId, profileId, name? }
  // Downloads signed 3MF + registers via same pipeline as upload.
  app.post<{
    Body: { numericId?: string; alphanumericId?: string; profileId?: string; name?: string };
  }>('/api/makerworld/import', async (req, reply) => {
    const { numericId, alphanumericId, profileId, name } = req.body ?? {};
    if (!numericId || !alphanumericId || !profileId) {
      return reply.status(400).send({ ok: false, error: 'numericId, alphanumericId, profileId required' });
    }

    const token = db.getSetting('bambu_cloud_token');
    if (!token) {
      return reply.status(400).send({ ok: false, error: 'Bambu cloud token required — set in Settings' });
    }

    const canonicalUrl = `https://makerworld.com/models/${numericId}#profileId-${profileId}`;

    // Dedup: if we've already imported this exact profile, return existing model
    const existing = db.findModelBySourceUrl(canonicalUrl);
    if (existing) {
      return {
        ok: true,
        data: {
          modelId: existing.id,
          name: existing.name,
          plateCount: existing.plate_count,
          deduped: true,
        },
      };
    }

    try {
      const signed = await getSignedDownloadUrl(profileId, alphanumericId, token);
      const buffer = await download3mf(signed.url);
      const filename = (name || signed.name || 'model.3mf').endsWith('.3mf')
        ? (name || signed.name || 'model.3mf')
        : `${name || signed.name || 'model'}.3mf`;

      const result = await register3MFModel(buffer, filename, db);
      db.updateModelSource(result.id, 'makerworld', canonicalUrl);

      // Capture embedded project settings so frontend can auto-apply on import
      const sourceSettings = await extractProjectSettings(buffer);
      if (sourceSettings) {
        db.updateModelSourceSettings(result.id, JSON.stringify(sourceSettings));
      }

      return { ok: true, data: { ...result, deduped: false } };
    } catch (e) {
      return reply.status(mwErrorStatus(e)).send({ ok: false, error: mwErrorMessage(e) });
    }
  });

  // GET /api/makerworld/thumbnail?url=...
  // Proxies a thumbnail image from MakerWorld CDN (avoids CSP issues).
  app.get<{ Querystring: { url?: string } }>('/api/makerworld/thumbnail', async (req, reply) => {
    const url = req.query.url;
    if (!url) return reply.status(400).send({ ok: false, error: 'url query param required' });

    try {
      const { data, contentType } = await fetchThumbnail(url);
      reply.header('Content-Type', contentType);
      reply.header('Cache-Control', 'public, max-age=3600');
      return reply.send(data);
    } catch (e) {
      return reply.status(mwErrorStatus(e)).send({ ok: false, error: mwErrorMessage(e) });
    }
  });

  // POST /api/makerworld/login { email, password?, code? }
  // Logs into Bambu Lab — returns token, or signals TOTP/email-code challenge.
  // On success: stores token via settings layer so caller doesn't have to.
  app.post<{ Body: { email?: string; password?: string; code?: string } }>(
    '/api/makerworld/login',
    async (req, reply) => {
      const { email, password, code } = req.body ?? {};
      if (!email) return reply.status(400).send({ ok: false, error: 'email required' });
      if (!password && !code) return reply.status(400).send({ ok: false, error: 'password or code required' });

      try {
        const result = await bambuLogin({ email, password, code });
        if (result.success && result.token) {
          db.setSetting('bambu_cloud_token', result.token);
        }
        return { ok: true, data: result };
      } catch (e) {
        return reply.status(mwErrorStatus(e)).send({ ok: false, error: mwErrorMessage(e) });
      }
    },
  );

  void MakerWorldError; // silence unused import in stricter setups
}
