import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

// Verifies that process settings sent via POST /api/slice (settings.process
// override) actually reach the slicer: setting layer_height=0.3 must produce
// `;HEIGHT:0.3` markers in the output gcode. Guards against the regression
// where user settings get clobbered by the default template.

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

test('layer_height override produces matching ;HEIGHT: in gcode', async () => {
  test.setTimeout(300000);

  const model = await uploadStl();
  console.log(`[lh] uploaded model=${model.id} faces=${model.faceCount}`);

  const result = await sliceAndWait({
    modelId: model.id,
    engine: 'orcaslicer',
    settings: {
      process: {
        layer_height: '0.3',
      },
    },
    filamentSlots: [{ color: '#FFFFFF', type: 'PLA' }],
  });

  console.log(`[lh] slice status=${result.status} err=${result.error}`);
  expect(result.status, `slice should complete, got: ${result.error ?? ''}`).toBe('completed');

  const gcode = await fetchGcode(result.jobId);

  // All non-first layers should carry ;HEIGHT:0.3 (or ;HEIGHT:0.30 — tolerate trailing zero).
  const heightLines = gcode.match(/^;HEIGHT:([\d.]+)/gm) ?? [];
  expect(heightLines.length, 'should have at least one ;HEIGHT: marker').toBeGreaterThan(0);

  const heights = heightLines.map(l => parseFloat(l.replace(/^;HEIGHT:/, '')));
  const distinct = new Set(heights);
  console.log(`[lh] distinct layer heights in gcode: ${[...distinct].join(', ')}`);

  // Most layers should match 0.3 — first layer may differ (initial_layer_height).
  // Require at least one 0.3-tolerance match.
  const matching = heights.filter(h => Math.abs(h - 0.3) < 0.01).length;
  expect(matching, 'most layers should match requested 0.3mm height').toBeGreaterThan(0);

  // Sanity: 0.2 (default) should NOT be the only height present, otherwise
  // the override was dropped.
  const defaultMatches = heights.filter(h => Math.abs(h - 0.2) < 0.01).length;
  expect(
    matching > defaultMatches || defaultMatches === 0,
    'override should win — 0.2 (default) should not dominate',
  ).toBe(true);

  // Cleanup
  await fetch(`${apiBase}/models/${model.id}`, { method: 'DELETE' });
});
