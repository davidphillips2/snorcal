import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Verifies that face paint applied via PUT /api/models/:id/colors actually
// reaches the slicer: the resulting gcode's `; extruder_colour = ...`
// metadata must list 2 distinct colors, AND the painted face distribution
// must produce T0+T1 tool usage. Distinct from the multimaterial spec in
// that this one specifically guards the paint → 3MF → gcode metadata path.

const apiBase = 'http://localhost:3000/api';
const stlPath = '/Users/david-mini/u1-slicer-bridge/test-data/3DBenchy.stl';

async function uploadStl(): Promise<{ id: string; faceCount: number }> {
  const bytes = await fs.promises.readFile(stlPath);
  const form = new FormData();
  form.append('file', new Blob([bytes]), path.basename(stlPath));
  const res = await fetch(`${apiBase}/models`, { method: 'POST', body: form });
  const j = await res.json();
  if (!j.ok) throw new Error(`upload failed: ${j.error}`);
  return { id: j.data.id, faceCount: j.data.faceCount as number };
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

async function paintStripe(modelId: string, faceCount: number): Promise<void> {
  // Encoding = RGBA per face (4 bytes), alpha=255 painted / 0 unpainted.
  // Paint ~middle third of faces with slot 1 color, rest with slot 0.
  // Any non-trivial split forces the slicer to switch tools mid-print.
  // Colors must match filamentSlots hex exactly for colorToExtruder lookup.
  const [r0, g0, b0] = hexToRgb('#00FF00');
  const [r1, g1, b1] = hexToRgb('#FF8800');
  const colors = new Uint8Array(faceCount * 4);
  const lo = Math.floor(faceCount * 0.33);
  const hi = Math.floor(faceCount * 0.66);
  for (let i = 0; i < faceCount; i++) {
    const use1 = i >= lo && i < hi;
    colors[i * 4]     = use1 ? r1 : r0;
    colors[i * 4 + 1] = use1 ? g1 : g0;
    colors[i * 4 + 2] = use1 ? b1 : b0;
    colors[i * 4 + 3] = 255; // painted
  }
  const base64 = Buffer.from(colors).toString('base64');
  const res = await fetch(`${apiBase}/models/${modelId}/colors`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ faceColors: base64 }),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`paint failed: ${j.error}`);
}

async function sliceAndWait(body: any): Promise<{ jobId: string; status: string; error?: string }> {
  const res = await fetch(`${apiBase}/slice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`slice submit failed: ${j.error}`);
  const jobId = j.data.jobId;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const jr = await (await fetch(`${apiBase}/jobs/${jobId}`)).json();
    const status = jr.data.status;
    if (status === 'completed' || status === 'failed') {
      return { jobId, status, error: jr.data.errorMessage };
    }
  }
  return { jobId, status: 'timeout' };
}

async function fetchGcode(jobId: string): Promise<string> {
  const res = await fetch(`${apiBase}/files/gcode/${jobId}`);
  if (!res.ok) throw new Error(`gcode fetch ${res.status}`);
  return await res.text();
}

test('painted face colors propagate to extruder_colour in gcode', async () => {
  test.setTimeout(300000);

  const model = await uploadStl();
  console.log(`[paint] uploaded model=${model.id} faces=${model.faceCount}`);
  expect(model.faceCount).toBeGreaterThan(0);

  await paintStripe(model.id, model.faceCount);

  const result = await sliceAndWait({
    modelId: model.id,
    engine: 'orcaslicer',
    settings: { process: {} },
    filamentSlots: [
      { color: '#00FF00', type: 'PLA' },
      { color: '#FF8800', type: 'PLA' },
    ],
  });

  console.log(`[paint] slice status=${result.status} err=${result.error}`);
  expect(result.status, `slice should complete, got: ${result.error ?? ''}`).toBe('completed');

  const gcode = await fetchGcode(result.jobId);

  // Header metadata — extruder_colour is a ;-del list of hex codes per slot.
  // OrcaSlicer emits uppercase; lowercase the comparison.
  const colorLine = gcode.match(/^; extruder_colour = (.+)$/m);
  expect(colorLine, 'extruder_colour metadata should exist').toBeTruthy();
  const parts = colorLine![1].split(';').map(s => s.trim().toLowerCase());
  expect(parts.length, 'should list at least 2 extruder colors').toBeGreaterThanOrEqual(2);
  // Both configured colors must appear (paintStripe uses both slots).
  expect(parts, 'should contain green #00ff00').toContain('#00ff00');
  expect(parts, 'should contain orange #ff8800').toContain('#ff8800');
  expect(new Set(parts).size, 'extruder_colour entries should be distinct').toBeGreaterThan(1);

  // Real toolchange usage — both T0 and T1 must appear in the body.
  expect(gcode, 'gcode should contain T0').toContain('T0');
  expect(gcode, 'gcode should contain T1 (paint forced toolchange)').toContain('T1');

  // Cleanup
  await fetch(`${apiBase}/models/${model.id}`, { method: 'DELETE' });
});
