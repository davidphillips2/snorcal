import { test, expect } from '@playwright/test';

// Verifies pause toggle UI: open a completed job's gcode preview, click pause,
// confirm amber marker + sidecar generated. Job-agnostic: picks the first
// completed job from the backend so the test works on any data state.
test('pause toggle injects gcode sidecar', async ({ page }) => {
  test.setTimeout(120000);

  page.on('pageerror', err => console.log('[PAGEERROR]', err.message));

  // --- Setup: pick a completed job + ensure clean pause state ---
  const setupRes = await fetch('http://localhost:3000/api/jobs?status=completed');
  const setupJson = await setupRes.json();
  const completed = setupJson.data as Array<{ id: string }>;
  expect(completed.length, 'need at least one completed job').toBeGreaterThan(0);
  const jobId = completed[0].id;

  // Clear any leftover pauses from prior runs
  await fetch(`http://localhost:3000/api/jobs/${jobId}/pauses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pauses: [] }),
  });

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(2000);

  // Navigate to slice view, open Jobs panel in sidebar (the sidebar Preview
  // button actually fetches gcode — jobs view Preview is buggy pre-existing).
  await page.locator('button:has-text("slice")').first().click();
  await page.waitForTimeout(1500);

  // Expand the Jobs section in sidebar (collapsed by default)
  await page.locator('button').filter({ hasText: /^Jobs \(\d+\)/ }).first().click();
  await page.waitForTimeout(800);

  // Click Preview button next to first completed job in sidebar
  const previewBtn = page.locator('button:has-text("Preview")').first();
  await previewBtn.waitFor({ state: 'visible', timeout: 5000 });
  await previewBtn.click();

  // Gcode fetch + parse can take 5-15s for big files.
  // Wait for the slider to appear (only renders after parser sets layer count).
  await page.locator('input[type="range"]').first().waitFor({ state: 'visible', timeout: 60000 });

  // Move slider to layer 10 (default is max = last layer, often out of range).
  // React's onChange fires from native input events — set value via the
  // prototype setter (React monkey-patches it) then dispatch input + change.
  const slider = page.locator('input[type="range"]').first();
  await slider.evaluate((el: HTMLInputElement, val) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, String(val));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, 10);
  await page.waitForTimeout(500);

  // Assert layer counter reflects the move (defends against silent nav failure)
  await expect(page.locator('text=L11/').first()).toBeVisible({ timeout: 5000 });

  await page.screenshot({ path: 'tests/30-pause-before.png' });

  // Click pause at current layer.
  // Dispatch click via evaluate: Playwright's click() re-queries the locator
  // post-click, but the button text mutates "+ Pause" → "⏸ ON", so the
  // re-query fails and click() never resolves.
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Pause'));
    if (!btn) throw new Error('pause button not found');
    btn.click();
  });
  await page.waitForTimeout(2500);

  await page.screenshot({ path: 'tests/31-pause-after.png' });

  // Verify sidecar was generated via backend API (jobId is dynamic)
  const apiBase = 'http://localhost:3000/api';
  const after = await (await fetch(`${apiBase}/jobs/${jobId}/pauses`)).json();
  expect(after.data.length).toBe(1);
  expect(after.data[0].layer).toBe(10);

  // Download paused gcode and confirm pause markers present
  const pausedGcode = await (await fetch(`${apiBase}/files/gcode/${jobId}?paused=1`)).text();
  expect(pausedGcode).toContain('snorcal pause');

  // Clear via API
  await fetch(`${apiBase}/jobs/${jobId}/pauses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pauses: [] }),
  });
  await page.waitForTimeout(1000);

  // Confirm cleared
  const cleared = await (await fetch(`${apiBase}/jobs/${jobId}/pauses`)).json();
  expect(cleared.data.length).toBe(0);

  await page.screenshot({ path: 'tests/32-pause-cleared.png' });
});
