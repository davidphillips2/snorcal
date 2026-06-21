import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Verifies that a 2-filament slice where the model has face paint actually
// produces T1 toolchanges in the output gcode. The existing UI-driven
// multi-material spec only checked job status — without painted faces the
// slicer emits a single T0 run, so toolchange coverage was missing.
//
// Pipeline: upload STL → paint first half of faces with filament index 1
// → POST /api/slice with 2 filamentSlots → poll job → GET gcode → assert T1.

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

async function paintHalfAndHalf(modelId: string, faceCount: number): Promise<void> {
  // Encoding = RGBA per face (4 bytes), alpha=255 painted / 0 unpainted.
  // First half faces → slot 0 color, second half → slot 1 color.
  // Must match filamentSlots color hex exactly so the slicer's
  // colorToExtruder lookup resolves to the right extruder.
  const [r0, g0, b0] = hexToRgb('#FF0000');
  const [r1, g1, b1] = hexToRgb('#0000FF');
  const colors = new Uint8Array(faceCount * 4);
  const half = Math.floor(faceCount / 2);
  for (let i = 0; i < faceCount; i++) {
    const use1 = i >= half;
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

test('painted 2-filament slice emits T1 toolchange in gcode', async () => {
  test.setTimeout(300000);

  const model = await uploadStl();
  console.log(`[mm-gcode] uploaded model=${model.id} faces=${model.faceCount}`);
  expect(model.faceCount, 'need faces to paint').toBeGreaterThan(0);

  await paintHalfAndHalf(model.id, model.faceCount);

  const result = await sliceAndWait({
    modelId: model.id,
    engine: 'orcaslicer',
    settings: { process: {} },
    filamentSlots: [
      { color: '#FF0000', type: 'PLA' },
      { color: '#0000FF', type: 'PLA' },
    ],
  });

  console.log(`[mm-gcode] slice status=${result.status} err=${result.error}`);
  expect(result.status, `slice should complete, got: ${result.error ?? ''}`).toBe('completed');

  const gcode = await fetchGcode(result.jobId);
  // T0 is always present (initial tool). T1 only appears on a real toolchange.
  expect(gcode, 'gcode should contain T0').toContain('T0');
  expect(gcode, 'painted multi-material gcode should contain T1 toolchange').toContain('T1');

  // Sanity: extruder_colour metadata should list both configured colors.
  // OrcaSlicer emits uppercase hex; lowercase the comparison.
  const colorLine = gcode.match(/^; extruder_colour = (.+)$/m);
  expect(colorLine, 'extruder_colour metadata should exist').toBeTruthy();
  expect(colorLine![1].toLowerCase(), 'should contain red').toContain('#ff0000');
  expect(colorLine![1].toLowerCase(), 'should contain blue').toContain('#0000ff');

  // Cleanup
  await fetch(`${apiBase}/models/${model.id}`, { method: 'DELETE' });
});
