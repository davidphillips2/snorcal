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

    // Find gcode file in output directory
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

    const stream = fs.createReadStream(gcodePath);
    return reply.send(stream);
  });

  // GET /api/files/model/:modelId — Download original model
  app.get<{ Params: { modelId: string } }>('/api/files/model/:modelId', async (req, reply) => {
    const model = db.getModel(req.params.modelId);
    if (!model) {
      return reply.status(404).send({ ok: false, error: 'Model not found' });
    }

    if (!fs.existsSync(model.file_path)) {
      return reply.status(404).send({ ok: false, error: 'Model file not found on disk' });
    }

    const stat = fs.statSync(model.file_path);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', stat.size);
    reply.header('Content-Disposition', `attachment; filename="${model.name}"`);

    const stream = fs.createReadStream(model.file_path);
    return reply.send(stream);
  });
}

function findGcode(dir: string): string | null {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isFile() && file.endsWith('.gcode')) {
      return fullPath;
    }
    if (stat.isDirectory()) {
      const found = findGcode(fullPath);
      if (found) return found;
    }
  }
  return null;
}
