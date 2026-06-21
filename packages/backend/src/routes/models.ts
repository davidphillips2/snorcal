import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuid } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { parseSTL, ensureDir, getModelsDir } from '../services/model-parser.js';
import { parse3MF, writePositionsToSTL, countPlates } from '../services/threemf-parser.js';

const MAX_FACES = 1_500_000;

export async function register3MFModel(
  buffer: Buffer,
  filename: string,
  db: Db,
): Promise<{ id: string; name: string; faceCount: number; bounds: { x: number; y: number; z: number }; plateCount: number }> {
  const id = uuid();
  const modelDir = path.join(getModelsDir(), id);
  ensureDir(modelDir);

  try {
    const plateCount = await countPlates(buffer);
    const originalPath = path.join(modelDir, filename);
    fs.writeFileSync(originalPath, buffer);

    const plateData: { index: number; faceCount: number; bounds: { x: number; y: number; z: number }; positions: Float32Array; faceColors?: Uint8Array }[] = [];
    // Collect negative parts during the parse loop, flush AFTER insertModel
    // so the FK on model_negative_parts.model_id is satisfiable.
    const negativeData: { plateIndex: number; partIndex: number; filePath: string; faceCount: number }[] = [];

    let faceCount = 0;
    let bounds = { x: 0, y: 0, z: 0 };
    let filePath = '';

    for (let p = 1; p <= plateCount; p++) {
      const parsed = await parse3MF(buffer, p);

      if (parsed.faceCount > MAX_FACES) {
        fs.rmSync(modelDir, { recursive: true, force: true });
        throw new Error(`Plate ${p} has ${parsed.faceCount.toLocaleString()} faces (max ${MAX_FACES.toLocaleString()}).`);
      }

      const platePath = path.join(modelDir, `plate_${p}.stl`);
      writePositionsToSTL(parsed.positions, platePath);

      // Stage negative parts (cutters/modifiers) so the slice pipeline can
      // re-emit them as Bambu negative volumes. Without this, MakerWorld
      // imports lose their keyring holes / cutter cuts at slice time.
      if (parsed.negativeParts && parsed.negativeParts.length > 0) {
        parsed.negativeParts.forEach((np, i) => {
          const negPath = path.join(modelDir, `negative_${p}_${i + 1}.stl`);
          writePositionsToSTL(np.positions, negPath);
          negativeData.push({
            plateIndex: p,
            partIndex: i + 1,
            filePath: negPath,
            faceCount: np.faceCount,
          });
        });
      }

      plateData.push({ index: p, faceCount: parsed.faceCount, bounds: parsed.bounds, positions: parsed.positions, faceColors: parsed.faceColors ?? undefined });

      if (p === 1) {
        faceCount = parsed.faceCount;
        bounds = parsed.bounds;
        filePath = platePath;
      }
    }

    db.insertModel({
      id,
      name: filename,
      filePath,
      fileSize: buffer.length,
      format: '3mf',
      faceCount,
      boundsX: bounds.x,
      boundsY: bounds.y,
      boundsZ: bounds.z,
      plateCount,
    });

    for (const pd of plateData) {
      db.insertPlate({
        modelId: id,
        plateIndex: pd.index,
        filePath: path.join(modelDir, `plate_${pd.index}.stl`),
        faceCount: pd.faceCount,
        boundsX: pd.bounds.x,
        boundsY: pd.bounds.y,
        boundsZ: pd.bounds.z,
      });
      if (pd.faceColors) {
        db.updatePlateColors(id, pd.index, Buffer.from(pd.faceColors));
      }
    }

    for (const nd of negativeData) {
      db.insertNegativePart({
        modelId: id,
        plateIndex: nd.plateIndex,
        partIndex: nd.partIndex,
        filePath: nd.filePath,
        faceCount: nd.faceCount,
      });
    }

    return { id, name: filename, faceCount, bounds, plateCount };
  } catch (err) {
    fs.rmSync(modelDir, { recursive: true, force: true });
    throw err;
  }
}

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

    const buffer = await data.toBuffer();
    const format = ext === '.stp' ? 'step' : ext.slice(1);

    if (format === '3mf') {
      try {
        const result = await register3MFModel(buffer, filename, db);
        return reply.send({ ok: true, data: result });
      } catch (err) {
        return reply.status(400).send({
          ok: false,
          error: `Invalid 3MF file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      // STL/STEP
      const id = uuid();
      const modelDir = path.join(getModelsDir(), id);
      ensureDir(modelDir);
      const filePath = path.join(modelDir, filename);
      fs.writeFileSync(filePath, buffer);

      let faceCount = 0;
      let bounds = { x: 0, y: 0, z: 0 };

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

      db.insertModel({
        id,
        name: filename,
        filePath,
        fileSize: buffer.length,
        format,
        faceCount,
        boundsX: bounds.x,
        boundsY: bounds.y,
        boundsZ: bounds.z,
        plateCount: 1,
      });

      return reply.send({
        ok: true,
        data: { id, name: filename, faceCount, bounds, plateCount: 1 },
      });
    }
  });

  // GET /api/models — List all models
  app.get('/api/models', async () => {
    const models = db.listModels();
    return { ok: true, data: models.map(m => ({
      id: m.id, name: m.name, format: m.format,
      faceCount: m.face_count, fileSize: m.file_size, plateCount: m.plate_count, createdAt: m.created_at,
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
        hasColors: (model.face_colors !== null) || (db.getPlate(model.id, 1)?.face_colors != null),
        plateCount: model.plate_count,
        createdAt: model.created_at,
        sourceType: model.source_type ?? null,
        hasSourceSettings: model.source_settings != null,
      },
    };
  });

  // GET /api/models/:id/source-settings — Returns captured MW 3MF project_settings.config JSON
  app.get<{ Params: { id: string } }>('/api/models/:id/source-settings', async (req, reply) => {
    const model = db.getModel(req.params.id);
    if (!model) {
      return reply.status(404).send({ ok: false, error: 'Model not found' });
    }
    if (!model.source_settings) {
      return reply.status(404).send({ ok: false, error: 'No source settings for this model' });
    }
    try {
      return { ok: true, data: JSON.parse(model.source_settings) };
    } catch {
      return reply.status(500).send({ ok: false, error: 'Stored source settings are corrupt' });
    }
  });

  // GET /api/models/:id/colors — Get face colors (?plate=N for multi-plate)
  app.get<{ Params: { id: string }, Querystring: { plate?: string } }>('/api/models/:id/colors', async (req, reply) => {
    const model = db.getModel(req.params.id);
    if (!model) {
      return reply.status(404).send({ ok: false, error: 'Model not found' });
    }

    const plateIndex = req.query.plate ? parseInt(req.query.plate) : 1;

    // Always prefer per-plate colors — register3MFModel saves there even for
    // single-plate 3MF imports. Works for both single + multi plate.
    const plate = db.getPlate(req.params.id, plateIndex);
    if (plate?.face_colors) {
      return { ok: true, data: { faceColors: Buffer.from(plate.face_colors).toString('base64') } };
    }

    // Backward compat: older single-plate uploads stored colors on the model row.
    if (model.face_colors) {
      return { ok: true, data: { faceColors: Buffer.from(model.face_colors).toString('base64') } };
    }

    return { ok: true, data: { faceColors: null } };
  });

  // PUT /api/models/:id/colors — Save painted face colors (?plate=N for multi-plate)
  app.put<{ Params: { id: string }, Querystring: { plate?: string } }>('/api/models/:id/colors', async (req, reply) => {
    const model = db.getModel(req.params.id);
    if (!model) {
      return reply.status(404).send({ ok: false, error: 'Model not found' });
    }

    const body = req.body as { faceColors?: string };
    if (!body?.faceColors) {
      return reply.status(400).send({ ok: false, error: 'faceColors required' });
    }

    const colorsBuffer = Buffer.from(body.faceColors, 'base64');
    const plateIndex = req.query.plate ? parseInt(req.query.plate) : undefined;

    if (model.plate_count > 1 && plateIndex) {
      db.updatePlateColors(req.params.id, plateIndex, colorsBuffer);
    } else {
      db.updateModelColors(req.params.id, colorsBuffer);
    }

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
