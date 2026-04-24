import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import type { Db } from '../db/index.js';

interface PrinterTestBody {
  printerIp: string;
  printerPort?: number;
}

interface PrinterSendBody {
  jobId: string;
  printerIp: string;
  printerPort?: number;
}

const MOONRAKER_PORT = 7125;

async function testPrinterConnection(ip: string, port: number = MOONRAKER_PORT): Promise<{ ok: boolean; info?: string; error?: string }> {
  try {
    const res = await fetch(`http://${ip}:${port}/printer/info`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json() as any;
    const state = json.result?.state || 'unknown';
    const version = json.result?.software_version || '';
    return { ok: true, info: `Klipper ${state}${version ? ` (${version})` : ''}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
  }
}

export async function printerRoutes(app: FastifyInstance, options: { db: Db }) {
  const { db } = options;

  // POST /api/printers/test — test connection to printer
  app.post('/api/printers/test', async (req: FastifyRequest, reply: FastifyReply) => {
    const { printerIp, printerPort } = req.body as PrinterTestBody;
    if (!printerIp) return reply.status(400).send({ ok: false, error: 'printerIp required' });
    const result = await testPrinterConnection(printerIp, printerPort);
    return reply.send({ ok: result.ok, data: { info: result.info, error: result.error } });
  });

  // POST /api/printers/send — upload gcode to Moonraker and start print
  app.post('/api/printers/send', async (req: FastifyRequest, reply: FastifyReply) => {
    const { jobId, printerIp, printerPort } = req.body as PrinterSendBody;
    if (!jobId || !printerIp) {
      return reply.status(400).send({ ok: false, error: 'jobId and printerIp required' });
    }

    const port = printerPort || MOONRAKER_PORT;
    const job = db.getJob(jobId);
    if (!job) return reply.status(404).send({ ok: false, error: 'Job not found' });
    if (job.status !== 'completed') return reply.status(400).send({ ok: false, error: 'Job not completed' });

    if (!job.output_dir) return reply.status(400).send({ ok: false, error: 'No output directory' });

    const gcodeFile = findGcode(job.output_dir);
    if (!gcodeFile) return reply.status(400).send({ ok: false, error: 'No gcode file found' });

    try {
      const fileName = path.basename(gcodeFile);
      const fileContent = fs.readFileSync(gcodeFile);
      const baseUrl = `http://${printerIp}:${port}`;

      // Upload via Moonraker multipart
      const formData = new FormData();
      formData.append('file', new Blob([fileContent]), fileName);
      formData.append('root', 'gcodes');

      console.log(`[printer] Uploading ${fileName} (${(fileContent.length / 1024).toFixed(0)}KB) to ${baseUrl}/server/files/upload`);

      const uploadRes = await fetch(`${baseUrl}/server/files/upload`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(120000),
      });

      if (!uploadRes.ok) {
        const errText = await uploadRes.text().catch(() => '');
        return reply.send({ ok: false, error: `Upload failed: HTTP ${uploadRes.status} ${errText}` });
      }

      const uploadResult = await uploadRes.json() as any;
      console.log(`[printer] Upload response:`, uploadResult.item?.path || uploadResult);

      // Start print via Moonraker
      const startRes = await fetch(`${baseUrl}/printer/print/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: uploadResult.item?.path || fileName }),
        signal: AbortSignal.timeout(10000),
      });

      if (!startRes.ok) {
        const errText = await startRes.text().catch(() => '');
        return reply.send({ ok: false, error: `Uploaded but start failed: ${errText}` });
      }

      return reply.send({ ok: true, data: { message: 'Print started' } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.send({ ok: false, error: `Send failed: ${message}` });
    }
  });
}

function findGcode(outputDir: string): string | null {
  if (!fs.existsSync(outputDir)) return null;
  const files = fs.readdirSync(outputDir);
  for (const file of files) {
    const fullPath = path.join(outputDir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isFile() && file.endsWith('.gcode')) return fullPath;
    if (stat.isDirectory()) {
      const result = findGcode(fullPath);
      if (result) return result;
    }
  }
  return null;
}
