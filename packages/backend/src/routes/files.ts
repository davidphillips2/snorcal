import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';

export async function fileRoutes(app: FastifyInstance, options: { db: Db }) {
  const { db } = options;

  // GET /api/files/gcode/:jobId — Download gcode
  app.get<{ Params: { jobId: string } }>('/api/files/gcode/:jobId', async (req, reply) => {
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

    const gcodePath = findGcode(outputDir);
    if (!gcodePath) {
      return reply.status(404).send({ ok: false, error: 'G-code file not found' });
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
}

function findGcode(dir: string): string | null {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isFile() && file.endsWith('.gcode')) return fullPath;
    if (stat.isDirectory()) {
      const found = findGcode(fullPath);
      if (found) return found;
    }
  }
  return null;
}
