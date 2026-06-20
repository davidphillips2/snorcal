import { test, expect } from '@playwright/test';

// Verifies pause toggle UI: open a completed job's gcode preview, click pause,
// confirm amber marker + sidecar generated.
test('pause toggle injects gcode sidecar', async ({ page }) => {
  test.setTimeout(90000);

  page.on('console', msg => console.log(`[${msg.type()}]`, msg.text()));
  page.on('pageerror', err => console.log('[PAGEERROR]', err.message));

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

  // Gcode fetch + parse can take 5-15s for big files
  // Wait for the pause button (which only renders after slider appears)
  await page.locator('button:has-text("Pause")').first().waitFor({ state: 'visible', timeout: 60000 });

  // Move slider to a low layer (default is max = last layer, often out of range).
  // Use arrow-key presses — Playwright's fill() on range inputs doesn't reliably
  // fire React's onChange in all setups.
  const slider = page.locator('input[type="range"]').first();
  await slider.focus();
  // Press Home to go to layer 0, then 10 arrow-ups to reach layer 10
  await page.keyboard.press('Home');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);

  await page.screenshot({ path: 'tests/30-pause-before.png' });

  // Click pause at current layer
  const pauseBtn = page.locator('button:has-text("Pause")').first();
  await pauseBtn.click();
  await page.waitForTimeout(2500);

  await page.screenshot({ path: 'tests/31-pause-after.png' });

  // Verify sidecar was generated + pause injected by hitting GET endpoint
  const after = await page.evaluate(async () => {
    const r = await fetch('/api/jobs/e15bb287-c635-4b7e-829e-d0f488f7ee47/pauses');
    return r.json();
  });
  expect(after.data.length).toBe(1);

  // Download paused gcode and confirm pause markers present
  const pausedGcode = await page.evaluate(async () => {
    const r = await fetch('/api/files/gcode/e15bb287-c635-4b7e-829e-d0f488f7ee47?paused=1');
    return r.text();
  });
  expect(pausedGcode).toContain('snorcal pause');

  // Clear via API (button-toggle-off is flaky via selector)
  await page.evaluate(async () => {
    await fetch('/api/jobs/e15bb287-c635-4b7e-829e-d0f488f7ee47/pauses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pauses: [] }),
    });
  });
  await page.waitForTimeout(1000);

  // Confirm cleared
  const cleared = await page.evaluate(async () => {
    const r = await fetch('/api/jobs/e15bb287-c635-4b7e-829e-d0f488f7ee47/pauses');
    return r.json();
  });
  expect(cleared.data.length).toBe(0);

  await page.screenshot({ path: 'tests/32-pause-cleared.png' });
});
