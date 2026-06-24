import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuid } from 'uuid';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { parseSTL, ensureDir, getModelsDir } from '../services/model-parser.js';
import { parse3MF, writePositionsToSTL, countPlates } from '../services/threemf-parser.js';
import { extractProjectSettings } from '../services/makerworld.js';

const MAX_FACES = 3_000_000;

export async function register3MFModel(
  buffer: Buffer,
  filename: string,
  db: Db,
): Promise<{
  id: string;
  name: string;
  faceCount: number;
  bounds: { x: number; y: number; z: number };
  boundsMin?: { x: number; y: number; z: number };
  boundsMax?: { x: number; y: number; z: number };
  plateCount: number;
  negativeParts?: Array<{ plateIndex: number; partIndex: number; faceCount: number; boundsMin?: { x: number; y: number; z: number }; boundsMax?: { x: number; y: number; z: number } }>;
  parts?: Array<{ plateIndex: number; partIndex: number; faceCount: number; name?: string; extruder?: number; boundsMin?: { x: number; y: number; z: number }; boundsMax?: { x: number; y: number; z: number } }>;
}> {
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
    const negativeData: { plateIndex: number; partIndex: number; filePath: string; faceCount: number; boundsMin?: { x: number; y: number; z: number }; boundsMax?: { x: number; y: number; z: number } }[] = [];
    // Same pattern for printable parts (sub-objects of a 3MF assembly).
    const printableData: { plateIndex: number; partIndex: number; filePath: string; faceCount: number; name?: string; extruder?: number; boundsMin?: { x: number; y: number; z: number }; boundsMax?: { x: number; y: number; z: number }; faceColors?: Uint8Array }[] = [];

    let faceCount = 0;
    let bounds = { x: 0, y: 0, z: 0 };
    let boundsMin: { x: number; y: number; z: number } | undefined;
    let boundsMax: { x: number; y: number; z: number } | undefined;
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
            boundsMin: np.boundsMin,
            boundsMax: np.boundsMax,
          });
        });
      }

      // Stage printable parts (sub-objects of a 3MF assembly) so the slice
      // pipeline can re-emit them as printable `<component>` entries of the
      // wrapper object — surfaces them as interactable children in the UI.
      if (parsed.parts && parsed.parts.length > 0) {
        parsed.parts.forEach((pp, i) => {
          const partPath = path.join(modelDir, `part_${p}_${i + 1}.stl`);
          writePositionsToSTL(pp.positions, partPath);
          printableData.push({
            plateIndex: p,
            partIndex: i + 1,
            filePath: partPath,
            faceCount: pp.faceCount,
            name: pp.name,
            extruder: pp.extruder,
            boundsMin: pp.boundsMin,
            boundsMax: pp.boundsMax,
            faceColors: pp.faceColors ?? undefined,
          });
        });
      }

      plateData.push({ index: p, faceCount: parsed.faceCount, bounds: parsed.bounds, positions: parsed.positions, faceColors: parsed.faceColors ?? undefined });

      if (p === 1) {
        faceCount = parsed.faceCount;
        bounds = parsed.bounds;
        boundsMin = parsed.boundsMin;
        boundsMax = parsed.boundsMax;
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
      boundsMinX: boundsMin?.x,
      boundsMinY: boundsMin?.y,
      boundsMinZ: boundsMin?.z,
      boundsMaxX: boundsMax?.x,
      boundsMaxY: boundsMax?.y,
      boundsMaxZ: boundsMax?.z,
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
        boundsMinX: nd.boundsMin?.x,
        boundsMinY: nd.boundsMin?.y,
        boundsMinZ: nd.boundsMin?.z,
        boundsMaxX: nd.boundsMax?.x,
        boundsMaxY: nd.boundsMax?.y,
        boundsMaxZ: nd.boundsMax?.z,
      });
    }

    for (const pp of printableData) {
      db.insertPrintablePart({
        modelId: id,
        plateIndex: pp.plateIndex,
        partIndex: pp.partIndex,
        filePath: pp.filePath,
        faceCount: pp.faceCount,
        name: pp.name,
        extruder: pp.extruder,
        boundsMinX: pp.boundsMin?.x,
        boundsMinY: pp.boundsMin?.y,
        boundsMinZ: pp.boundsMin?.z,
        boundsMaxX: pp.boundsMax?.x,
        boundsMaxY: pp.boundsMax?.y,
        boundsMaxZ: pp.boundsMax?.z,
        faceColors: pp.faceColors ? Buffer.from(pp.faceColors) : undefined,
      });
    }

    // Capture embedded project_settings.config (filament_colour/type, printer
    // profile, layer settings) — same path MakerWorld flow uses. Lets the
    // frontend populate filament slots on ANY 3MF upload, not just MW imports.
    const sourceSettings = await extractProjectSettings(buffer);
    if (sourceSettings) {
      db.updateModelSourceSettings(id, JSON.stringify(sourceSettings));
      if (!db.getModel(id)?.source_type) {
        db.updateModelSource(id, '3mf-bundle', null);
      }
    }

    return {
      id,
      name: filename,
      faceCount,
      bounds,
      boundsMin,
      boundsMax,
      plateCount,
      negativeParts: negativeData.length > 0
        ? negativeData.map(nd => ({
            plateIndex: nd.plateIndex,
            partIndex: nd.partIndex,
            faceCount: nd.faceCount,
            boundsMin: nd.boundsMin,
            boundsMax: nd.boundsMax,
          }))
        : undefined,
      parts: printableData.length > 0
        ? printableData.map(pp => ({
            plateIndex: pp.plateIndex,
            partIndex: pp.partIndex,
            faceCount: pp.faceCount,
            name: pp.name,
            extruder: pp.extruder,
            boundsMin: pp.boundsMin,
            boundsMax: pp.boundsMax,
          }))
        : undefined,
    };
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
        const stored = db.getModel(result.id);
        return reply.send({
          ok: true,
          data: {
            ...result,
            hasSourceSettings: stored?.source_settings != null,
            sourceType: stored?.source_type ?? null,
          },
        });
      } catch (err) {
        return reply.status(400).send({
          ok: false,
          error: `Invalid 3MF file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else if (format === 'stl' || format === 'step') {
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
    // Surface plate-1 negative parts so MakerWorld imports (which don't see
    // the upload response) can build child ProjectModels the same way plain
    // uploads do.
    const negativeParts = db.listNegativeParts(model.id, 1).map(np => ({
      plateIndex: np.plate_index,
      partIndex: np.part_index,
      faceCount: np.face_count,
      boundsMin: np.bounds_min_x != null && np.bounds_min_y != null && np.bounds_min_z != null
        ? { x: np.bounds_min_x, y: np.bounds_min_y, z: np.bounds_min_z }
        : undefined,
      boundsMax: np.bounds_max_x != null && np.bounds_max_y != null && np.bounds_max_z != null
        ? { x: np.bounds_max_x, y: np.bounds_max_y, z: np.bounds_max_z }
        : undefined,
    }));
    const parts = db.listPrintableParts(model.id, 1).map(pp => ({
      plateIndex: pp.plate_index,
      partIndex: pp.part_index,
      faceCount: pp.face_count,
      name: pp.name ?? undefined,
      extruder: pp.extruder ?? undefined,
      boundsMin: pp.bounds_min_x != null && pp.bounds_min_y != null && pp.bounds_min_z != null
        ? { x: pp.bounds_min_x, y: pp.bounds_min_y, z: pp.bounds_min_z }
        : undefined,
      boundsMax: pp.bounds_max_x != null && pp.bounds_max_y != null && pp.bounds_max_z != null
        ? { x: pp.bounds_max_x, y: pp.bounds_max_y, z: pp.bounds_max_z }
        : undefined,
    }));
    return {
      ok: true,
      data: {
        id: model.id,
        name: model.name,
        format: model.format,
        faceCount: model.face_count,
        fileSize: model.file_size,
        bounds: { x: model.bounds_x, y: model.bounds_y, z: model.bounds_z },
        boundsMin: model.bounds_min_x != null && model.bounds_min_y != null && model.bounds_min_z != null
          ? { x: model.bounds_min_x, y: model.bounds_min_y, z: model.bounds_min_z }
          : undefined,
        boundsMax: model.bounds_max_x != null && model.bounds_max_y != null && model.bounds_max_z != null
          ? { x: model.bounds_max_x, y: model.bounds_max_y, z: model.bounds_max_z }
          : undefined,
        hasColors: (model.face_colors !== null) || (db.getPlate(model.id, 1)?.face_colors != null),
        plateCount: model.plate_count,
        createdAt: model.created_at,
        sourceType: model.source_type ?? null,
        hasSourceSettings: model.source_settings != null,
        negativeParts: negativeParts.length > 0 ? negativeParts : undefined,
        parts: parts.length > 0 ? parts : undefined,
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
    const plateIndex = req.query.plate ? parseInt(req.query.plate) : 1;

    // Mirror GET preference: if a plate row exists (3MF uploads always have one),
    // write there so subsequent reads see the user's paint. STL has no plate row,
    // so fall back to model.face_colors.
    const plate = db.getPlate(req.params.id, plateIndex);
    if (plate) {
      db.updatePlateColors(req.params.id, plateIndex, colorsBuffer);
    } else {
      db.updateModelColors(req.params.id, colorsBuffer);
    }

    return { ok: true };
  });

  // GET /api/models/:id/parts/:plate/:part/colors — Get per-part face colors
  // (parts have their own face_colors blob; parent's merged blob uses different indices)
  app.get<{ Params: { id: string; plate: string; part: string } }>(
    '/api/models/:id/parts/:plate/:part/colors',
    async (req, reply) => {
      const plateNum = parseInt(req.params.plate);
      const partNum = parseInt(req.params.part);
      const parts = db.listPrintableParts(req.params.id, plateNum);
      const pp = parts.find(p => p.part_index === partNum);
      if (!pp) {
        return reply.status(404).send({ ok: false, error: 'Printable part not found' });
      }
      if (!pp.face_colors) {
        return { ok: true, data: { faceColors: null } };
      }
      return { ok: true, data: { faceColors: Buffer.from(pp.face_colors).toString('base64') } };
    },
  );

  // PUT /api/models/:id/parts/:plate/:part/colors — Save per-part painted colors
  app.put<{ Params: { id: string; plate: string; part: string } }>(
    '/api/models/:id/parts/:plate/:part/colors',
    async (req, reply) => {
      const plateNum = parseInt(req.params.plate);
      const partNum = parseInt(req.params.part);
      const parts = db.listPrintableParts(req.params.id, plateNum);
      const pp = parts.find(p => p.part_index === partNum);
      if (!pp) {
        return reply.status(404).send({ ok: false, error: 'Printable part not found' });
      }
      const body = req.body as { faceColors?: string };
      if (!body?.faceColors) {
        return reply.status(400).send({ ok: false, error: 'faceColors required' });
      }
      const colorsBuffer = Buffer.from(body.faceColors, 'base64');
      db.updatePrintablePartColors(req.params.id, plateNum, partNum, colorsBuffer);
      return { ok: true };
    },
  );

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
