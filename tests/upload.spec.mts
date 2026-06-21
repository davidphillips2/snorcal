import { test, expect } from '@playwright/test';
import path from 'node:path';

// Verifies the upload pipeline: STL → POST /api/models (multipart) →
// appears in /api/models list → mesh loads in viewer.
// Regression guard for the model upload + non-indexed geometry path.
test('STL upload lands in models list + viewer', async ({ page }) => {
  test.setTimeout(60000);

  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  const apiBase = 'http://localhost:3000/api';
  const stlPath = '/Users/david-mini/u1-slicer-bridge/test-data/3DBenchy.stl';
  const stlName = path.basename(stlPath);

  // Snapshot models count before
  const before = await (await fetch(`${apiBase}/models`)).json();
  const beforeCount = before.data.length;

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(1500);

  await page.locator('button:has-text("slice")').first().click();
  await page.waitForTimeout(1500);

  // Hidden file input accepts STL/3MF
  const fileInput = page.locator('input[type="file"][accept=".stl,.step,.stp,.3mf"]').first();
  await fileInput.setInputFiles(stlPath);

  // Upload + STL parse + scene add — give it room
  await page.waitForTimeout(4000);

  await page.screenshot({ path: 'tests/50-upload-loaded.png' });

  // Verify backend registered the model
  const after = await (await fetch(`${apiBase}/models`)).json();
  expect(after.data.length, 'model count should grow by 1').toBe(beforeCount + 1);

  // Find the just-uploaded entry (last created; name may include plate suffix)
  const uploaded = after.data.find((m: any) => m.name?.includes(stlName) || m.name === stlName);
  expect(uploaded, 'uploaded model should be in list').toBeTruthy();
  expect(uploaded.faceCount).toBeGreaterThan(0);

  // Cleanup
  await fetch(`${apiBase}/models/${uploaded.id}`, { method: 'DELETE' });

  expect(errors, 'no page errors during upload').toEqual([]);
});
