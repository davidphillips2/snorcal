import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';

interface Options {
  db: Db;
}

function toSpool(row: any) {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    material: row.material,
    totalWeightG: row.total_weight_g,
    remainingWeightG: row.remaining_weight_g,
    costPerKg: row.cost_per_kg,
    purchasedAt: row.purchased_at,
    notes: row.notes,
    archived: !!row.archived,
    createdAt: row.created_at,
  };
}

function toPrintHistory(row: any) {
  return {
    id: row.id,
    jobId: row.job_id,
    printerId: row.printer_id,
    modelName: row.model_name,
    completedAt: row.completed_at,
    photoPath: row.photo_path,
    photoUrl: row.photo_path ? `/api/inventory/print-history/${row.id}/photo` : null,
    rating: row.rating,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export async function inventoryRoutes(app: FastifyInstance, opts: Options) {
  const { db } = opts;

  // --- Spools ---

  app.get('/api/inventory/spools', async (req, reply) => {
    const archived = (req.query as { archived?: string }).archived === 'true';
    const rows = db.listSpools(archived);
    return rows.map(toSpool);
  });

  app.post('/api/inventory/spools', async (req) => {
    const b = req.body as {
      name: string; color?: string; material?: string;
      totalWeightG?: number; remainingWeightG?: number; costPerKg?: number;
      purchasedAt?: string; notes?: string;
    };
    const id = randomUUID();
    db.insertSpool({
      id, name: b.name, color: b.color ?? null, material: b.material ?? null,
      total_weight_g: b.totalWeightG, remaining_weight_g: b.remainingWeightG ?? b.totalWeightG,
      cost_per_kg: b.costPerKg ?? 0, purchased_at: b.purchasedAt ?? null, notes: b.notes ?? null,
    });
    return toSpool(db.getSpool(id));
  });

  app.put('/api/inventory/spools/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as Partial<{
      name: string; color: string | null; material: string | null;
      totalWeightG: number; remainingWeightG: number; costPerKg: number;
      purchasedAt: string | null; notes: string | null; archived: boolean;
    }>;
    db.updateSpool(id, {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.color !== undefined ? { color: b.color } : {}),
      ...(b.material !== undefined ? { material: b.material } : {}),
      ...(b.totalWeightG !== undefined ? { total_weight_g: b.totalWeightG } : {}),
      ...(b.remainingWeightG !== undefined ? { remaining_weight_g: b.remainingWeightG } : {}),
      ...(b.costPerKg !== undefined ? { cost_per_kg: b.costPerKg } : {}),
      ...(b.purchasedAt !== undefined ? { purchased_at: b.purchasedAt } : {}),
      ...(b.notes !== undefined ? { notes: b.notes } : {}),
      ...(b.archived !== undefined ? { archived: b.archived ? 1 : 0 } : {}),
    });
    return toSpool(db.getSpool(id));
  });

  app.delete('/api/inventory/spools/:id', async (req) => {
    const { id } = req.params as { id: string };
    db.deleteSpool(id);
    return { ok: true };
  });

  // --- Print history ---

  app.get('/api/inventory/print-history', async (req) => {
    const limit = parseInt((req.query as { limit?: string }).limit ?? '100', 10);
    return db.listPrintHistory(limit).map(toPrintHistory);
  });

  app.get('/api/inventory/print-history/:id', async (req) => {
    const { id } = req.params as { id: string };
    const h = db.getPrintHistory(id);
    return h ? toPrintHistory(h) : null;
  });

  app.post('/api/inventory/print-history', async (req) => {
    const b = req.body as {
      jobId?: string; printerId?: string; modelName?: string;
      rating?: number; notes?: string; completedAt?: string;
    };
    const id = randomUUID();
    db.insertPrintHistory({
      id, job_id: b.jobId, printer_id: b.printerId, model_name: b.modelName,
      rating: b.rating ?? null, notes: b.notes ?? null, completed_at: b.completedAt,
    });
    return toPrintHistory(db.getPrintHistory(id));
  });

  app.put('/api/inventory/print-history/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = req.body as Partial<{
      photo_path: string | null; rating: number | null;
      notes: string | null; printerId: string | null;
    }>;
    db.updatePrintHistory(id, {
      ...(b.photo_path !== undefined ? { photo_path: b.photo_path } : {}),
      ...(b.rating !== undefined ? { rating: b.rating } : {}),
      ...(b.notes !== undefined ? { notes: b.notes } : {}),
      ...(b.printerId !== undefined ? { printer_id: b.printerId } : {}),
    });
    return toPrintHistory(db.getPrintHistory(id));
  });

  app.delete('/api/inventory/print-history/:id', async (req) => {
    const { id } = req.params as { id: string };
    const h = db.getPrintHistory(id);
    if (h?.photo_path && fs.existsSync(h.photo_path)) {
      try { fs.unlinkSync(h.photo_path); } catch { /* ignore */ }
    }
    db.deletePrintHistory(id);
    return { ok: true };
  });

  // Photo upload (multipart)
  app.post('/api/inventory/print-history/:id/photo', async (req, reply) => {
    const { id } = req.params as { id: string };
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'No file' });
    const dir = path.join(process.env.HOME || '/tmp', '.snorcal', 'print-photos');
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(data.filename || '.jpg') || '.jpg';
    const filePath = path.join(dir, `${id}${ext}`);
    const stream = fs.createWriteStream(filePath);
    await new Promise<void>((resolve, reject) => {
      data.file.pipe(stream);
      data.file.on('end', resolve);
      data.file.on('error', reject);
    });
    db.updatePrintHistory(id, { photo_path: filePath });
    return toPrintHistory(db.getPrintHistory(id));
  });

  // Photo download
  app.get('/api/inventory/print-history/:id/photo', async (req, reply) => {
    const { id } = req.params as { id: string };
    const h = db.getPrintHistory(id);
    if (!h?.photo_path || !fs.existsSync(h.photo_path)) return reply.code(404).send({ error: 'No photo' });
    return reply.sendFile(h.photo_path);
  });
}
