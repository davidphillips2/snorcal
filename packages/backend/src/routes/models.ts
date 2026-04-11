import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuid } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { parseSTL, ensureDir, getModelsDir } from '../services/model-parser.js';
import { parse3MF, writePositionsToSTL } from '../services/threemf-parser.js';

export async function modelRoutes(app: FastifyInstance, options: { db: Db }) {
  const { db } = options;

  // POST /api/models — Upload STL/3MF file
  app.post('/api/models', async (req: FastifyRequest, reply: FastifyReply) => {
    const data = await req.file();

    if (!data) {
      return reply.status(400).send({ ok: false, error: 'No file uploaded' });
    }

    const filename = data.filename;
    const ext = path.extname(filename).toLowerCase();
    if (ext !== '.stl' && ext !== '.step' && ext !== '.stp' && ext !== '.3mf') {
      return reply.status(400).send({ ok: false, error: 'Only STL, STEP, and 3MF files are supported' });
    }

    const id = uuid();
    const modelDir = path.join(getModelsDir(), id);
    ensureDir(modelDir);

    const buffer = await data.toBuffer();
    const format = ext === '.stp' ? 'step' : ext.slice(1);

    let faceCount = 0;
    let bounds = { x: 0, y: 0, z: 0 };
    let faceColors: Buffer | null = null;
    let filePath: string;

    if (format === '3mf') {
      // Parse 3MF — extract geometry, colors, and save as STL for viewer
      try {
        const parsed = await parse3MF(buffer);
        faceCount = parsed.faceCount;
        bounds = parsed.bounds;

        // Reject models that are too large for the web viewer
        const MAX_FACES = 1_500_000;
        if (faceCount > MAX_FACES) {
          fs.rmSync(modelDir, { recursive: true, force: true });
          return reply.status(400).send({
            ok: false,
            error: `Model has ${faceCount.toLocaleString()} faces (max ${MAX_FACES.toLocaleString()}). Try simplifying the mesh before uploading.`,
          });
        }

        // Save original 3MF for slicing
        const originalPath = path.join(modelDir, filename);
        fs.writeFileSync(originalPath, buffer);

        // Extract STL for viewer
        filePath = path.join(modelDir, 'extracted.stl');
        writePositionsToSTL(parsed.positions, filePath);

        if (parsed.faceColors) {
          faceColors = Buffer.from(parsed.faceColors);
        }
      } catch (err) {
        fs.rmSync(modelDir, { recursive: true, force: true });
        return reply.status(400).send({
          ok: false,
          error: `Invalid 3MF file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      // STL/STEP — existing logic
      filePath = path.join(modelDir, filename);
      fs.writeFileSync(filePath, buffer);

      if (format === 'stl') {
        try {
          const parsed = parseSTL(filePath);
          faceCount = parsed.faceCount;
          bounds = parsed.bounds;
        } catch (err) {
          fs.rmSync(modelDir, { recursive: true, force: true });
          return reply.status(400).send({
            ok: false,
            error: `Invalid STL file: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    db.insertModel({
      id,
      name: filename,
      filePath: filePath!,
      fileSize: buffer.length,
      format,
      faceCount,
      boundsX: bounds.x,
      boundsY: bounds.y,
      boundsZ: bounds.z,
    });

    // Save face colors if extracted from 3MF
    if (faceColors) {
      db.updateModelColors(id, faceColors);
    }

    return reply.send({
      ok: true,
      data: { id, name: filename, faceCount, bounds },
    });
  });

  // GET /api/models — List all models
  app.get('/api/models', async () => {
    const models = db.listModels();
    return { ok: true, data: models.map(m => ({
      id: m.id, name: m.name, format: m.format,
      faceCount: m.face_count, fileSize: m.file_size, createdAt: m.created_at,
    })) };
  });

  // GET /api/models/:id — Get model metadata
  app.get<{ Params: { id: string } }>('/api/models/:id', async (req, reply) => {
    const model = db.getModel(req.params.id);
    if (!model) {
      return reply.status(404).send({ ok: false, error: 'Model not found' });
    }
    return {
      ok: true,
      data: {
        id: model.id,
        name: model.name,
        format: model.format,
        faceCount: model.face_count,
        fileSize: model.file_size,
        bounds: { x: model.bounds_x, y: model.bounds_y, z: model.bounds_z },
        hasColors: model.face_colors !== null,
        createdAt: model.created_at,
      },
    };
  });

  // GET /api/models/:id/colors — Get face colors
  app.get<{ Params: { id: string } }>('/api/models/:id/colors', async (req, reply) => {
    const model = db.getModel(req.params.id);
    if (!model) {
      return reply.status(404).send({ ok: false, error: 'Model not found' });
    }

    if (!model.face_colors) {
      return { ok: true, data: { faceColors: null } };
    }

    const base64 = Buffer.from(model.face_colors).toString('base64');
    return { ok: true, data: { faceColors: base64 } };
  });

  // PUT /api/models/:id/colors — Save painted face colors
  app.put<{ Params: { id: string } }>('/api/models/:id/colors', async (req, reply) => {
    const model = db.getModel(req.params.id);
    if (!model) {
      return reply.status(404).send({ ok: false, error: 'Model not found' });
    }

    const body = req.body as { faceColors?: string };
    if (!body?.faceColors) {
      return reply.status(400).send({ ok: false, error: 'faceColors required' });
    }

    const colorsBuffer = Buffer.from(body.faceColors, 'base64');
    db.updateModelColors(req.params.id, colorsBuffer);

    return { ok: true };
  });

  // DELETE /api/models/:id — Delete model
  app.delete<{ Params: { id: string } }>('/api/models/:id', async (req, reply) => {
    const model = db.getModel(req.params.id);
    if (!model) {
      return reply.status(404).send({ ok: false, error: 'Model not found' });
    }

    const modelDir = path.dirname(model.file_path);
    if (fs.existsSync(modelDir)) {
      fs.rmSync(modelDir, { recursive: true, force: true });
    }

    db.deleteModel(req.params.id);
    return { ok: true };
  });
}
