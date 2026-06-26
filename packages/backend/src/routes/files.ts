import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import type { SliceRequest } from '@snorcal/shared';
import { buildSliceInput3MF } from './slice.js';

export async function fileRoutes(app: FastifyInstance, options: { db: Db }) {
  const { db } = options;

  // GET /api/files/gcode/:jobId — Download gcode (?paused=1 serves manual-pause variant)
  app.get<{ Params: { jobId: string }, Querystring: { paused?: string } }>('/api/files/gcode/:jobId', async (req, reply) => {
    const job = db.getJob(req.params.jobId);
    if (!job) {
      return reply.status(404).send({ ok: false, error: 'Job not found' });
    }

    if (job.status !== 'completed') {
      return reply.status(400).send({ ok: false, error: 'Job not completed' });
    }

    const outputDir = job.output_dir;
    if (!outputDir || !fs.existsSync(outputDir)) {
      return reply.status(404).send({ ok: false, error: 'Output directory not found' });
    }

    const wantPaused = req.query.paused === '1';
    const gcodePath = wantPaused ? findPausedGcode(outputDir) : findGcode(outputDir);
    if (!gcodePath) {
      return reply.status(404).send({ ok: false, error: wantPaused ? 'Paused gcode not generated' : 'G-code file not found' });
    }

    const stat = fs.statSync(gcodePath);
    const filename = path.basename(gcodePath);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', stat.size);
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(fs.createReadStream(gcodePath));
  });

  // GET /api/files/model/:modelId — Download original model (?plate=N for multi-plate)
  app.get<{ Params: { modelId: string }, Querystring: { plate?: string } }>('/api/files/model/:modelId', async (req, reply) => {
    const model = db.getModel(req.params.modelId);
    if (!model) {
      return reply.status(404).send({ ok: false, error: 'Model not found' });
    }

    let filePath = model.file_path;
    const plateNum = req.query.plate ? parseInt(req.query.plate) : undefined;

    if (plateNum && model.plate_count > 1) {
      const plate = db.getPlate(req.params.modelId, plateNum);
      if (plate) filePath = plate.file_path;
    }

    if (!fs.existsSync(filePath)) {
      return reply.status(404).send({ ok: false, error: 'Model file not found on disk' });
    }

    const stat = fs.statSync(filePath);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', stat.size);
    reply.header('Content-Disposition', `attachment; filename="${model.name}"`);
    return reply.send(fs.createReadStream(filePath));
  });

  // GET /api/files/model/:modelId/negative/:plate/:part — Serve embedded negative part STL
  app.get<{ Params: { modelId: string; plate: string; part: string } }>(
    '/api/files/model/:modelId/negative/:plate/:part',
    async (req, reply) => {
      const plateNum = parseInt(req.params.plate);
      const partNum = parseInt(req.params.part);
      const parts = db.listNegativeParts(req.params.modelId, plateNum);
      const np = parts.find(p => p.part_index === partNum);
      if (!np) {
        return reply.status(404).send({ ok: false, error: 'Negative part not found' });
      }
      if (!fs.existsSync(np.file_path)) {
        return reply.status(404).send({ ok: false, error: 'Negative part file not found on disk' });
      }
      const stat = fs.statSync(np.file_path);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', stat.size);
      reply.header('Content-Disposition', `attachment; filename="negative_${plateNum}_${partNum}.stl"`);
      return reply.send(fs.createReadStream(np.file_path));
    },
  );

  // GET /api/files/model/:modelId/part/:plate/:part — Serve printable sub-object STL
  app.get<{ Params: { modelId: string; plate: string; part: string } }>(
    '/api/files/model/:modelId/part/:plate/:part',
    async (req, reply) => {
      const plateNum = parseInt(req.params.plate);
      const partNum = parseInt(req.params.part);
      const parts = db.listPrintableParts(req.params.modelId, plateNum);
      const pp = parts.find(p => p.part_index === partNum);
      if (!pp) {
        return reply.status(404).send({ ok: false, error: 'Printable part not found' });
      }
      if (!fs.existsSync(pp.file_path)) {
        return reply.status(404).send({ ok: false, error: 'Printable part file not found on disk' });
      }
      const stat = fs.statSync(pp.file_path);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', stat.size);
      reply.header('Content-Disposition', `attachment; filename="part_${plateNum}_${partNum}.stl"`);
      return reply.send(fs.createReadStream(pp.file_path));
    },
  );

  // GET /api/files/threemf/:jobId — Download input 3MF used for slicing
  app.get<{ Params: { jobId: string } }>('/api/files/threemf/:jobId', async (req, reply) => {
    const job = db.getJob(req.params.jobId);
    if (!job) {
      return reply.status(404).send({ ok: false, error: 'Job not found' });
    }

    if (!job.output_dir) {
      return reply.status(404).send({ ok: false, error: 'No output directory' });
    }

    const workDir = path.dirname(job.output_dir);
    const threemfPath = path.join(workDir, 'input.3mf');

    if (!fs.existsSync(threemfPath)) {
      return reply.status(404).send({ ok: false, error: '3MF file not found' });
    }

    const modelName = job.model_name || 'model';
    const stat = fs.statSync(threemfPath);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', stat.size);
    reply.header('Content-Disposition', `attachment; filename="${modelName}.3mf"`);
    return reply.send(fs.createReadStream(threemfPath));
  });

  // POST /api/files/preview-3mf — Build the input 3MF without slicing.
  // Body: same shape as POST /api/slice (SliceRequest). Returns the 3MF as a
  // download. Use for testing in OrcaSlicer / bambuddy UI / BambuStudio
  // directly when a slice fails and you want to inspect what snorcal would
  // have sent, or to bypass the slice step entirely.
  app.post('/api/files/preview-3mf', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as SliceRequest;
    if ((!body.modelId && !body.models) || !body.engine) {
      return reply.status(400).send({ ok: false, error: 'modelId (or models) and engine are required' });
    }
    // Validate model(s) exist so the helper doesn't crash on a missing record
    const ids: string[] = body.models
      ? body.models.map((m: any) => m.modelId).filter(Boolean) as string[]
      : (body.modelId ? [body.modelId] : []);
    for (const id of ids) {
      if (!db.getModel(id)) {
        return reply.status(404).send({ ok: false, error: `Model ${id} not found` });
      }
    }
    try {
      const buf = await buildSliceInput3MF(body, db, '');
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', buf.length);
      // Filename: prefer first model's name, fallback to "preview"
      const firstModelId = ids[0];
      const firstModel = firstModelId ? db.getModel(firstModelId) : null;
      const fname = (firstModel?.name || 'preview').replace(/[^a-zA-Z0-9._-]/g, '_');
      reply.header('Content-Disposition', `attachment; filename="${fname}.3mf"`);
      return reply.send(buf);
    } catch (err) {
      return reply.status(500).send({
        ok: false,
        error: `Failed to build 3MF: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

function findGcode(dir: string): string | null {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    // Skip `.paused.gcode` sidecars — those are manual-pause variants,
    // not the canonical slicer output. Caller fetches them explicitly.
    if (stat.isFile() && file.endsWith('.gcode') && !file.endsWith('.paused.gcode')) {
      return fullPath;
    }
    if (stat.isDirectory()) {
      const found = findGcode(fullPath);
      if (found) return found;
    }
  }
  return null;
}

function findPausedGcode(dir: string): string | null {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isFile() && file.endsWith('.paused.gcode')) return fullPath;
    if (stat.isDirectory()) {
      const found = findPausedGcode(fullPath);
      if (found) return found;
    }
  }
  return null;
}
