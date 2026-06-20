import { test, expect } from '@playwright/test';

// Drives the UI to submit a 2-color multi-material slice and verifies the
// job reaches 'completed' state. Covers the filament_id-scalar regression.
test('multi-material slice via UI reaches completed', async ({ page }) => {
  test.setTimeout(180000);

  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(2500);

  // Navigate to slice view (home shows printers/jobs dashboard)
  await page.locator('button[aria-label="slice"], button:has-text("slice")').first().click();
  await page.waitForTimeout(1500);

  // Upload a small STL via the hidden file input (fresh browser = empty plate)
  const stlPath = '/Users/david-mini/slorca/packages/backend/data/models/86c5bf0a-23b2-4026-bf4c-d8e44c2fbedf/plate_1.stl';
  const fileInput = page.locator('input[type="file"][accept=".stl,.step,.stp,.3mf"]').first();
  await fileInput.setInputFiles(stlPath);
  // Wait for upload + model to land in the scene
  await page.waitForTimeout(3000);

  // Snapshot initial state
  await page.screenshot({ path: 'tests/20-mm-initial.png' });

  // Open Settings panel (collapsed by default in slice view)
  const settingsToggle = page.locator('button:has-text("Settings")').first();
  if (await settingsToggle.isVisible({ timeout: 2000 }).catch(() => false)) {
    const btnText = await settingsToggle.textContent();
    if (btnText && btnText.includes('+')) {
      await settingsToggle.click();
      await page.waitForTimeout(500);
    }
  }

  // Expand "Advanced" section — Machine/Process/Filament Slots live behind it
  const advancedToggle = page.locator('button:has-text("Advanced")').first();
  const advText = await advancedToggle.textContent().catch(() => '');
  if (advText && advText.includes('+')) {
    await advancedToggle.click();
    await page.waitForTimeout(500);
  }

  // Add a 2nd filament slot (default is single-slot)
  const addSlotBtn = page.locator('button:has-text("+ Add Slot")').first();
  await addSlotBtn.waitFor({ state: 'visible', timeout: 5000 });
  await addSlotBtn.click();
  await page.waitForTimeout(500);

  // Confirm 2 filament rows exist (color picker inputs)
  const colorInputs = page.locator('input[type="color"]');
  await expect(colorInputs).toHaveCount(2, { timeout: 2000 });

  // Set slot 1 = red, slot 2 = blue (force explicit colors regardless of defaults)
  await colorInputs.nth(0).evaluate((el: HTMLInputElement) => {
    el.value = '#FF0000';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await colorInputs.nth(1).evaluate((el: HTMLInputElement) => {
    el.value = '#0000FF';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);

  await page.screenshot({ path: 'tests/21-mm-2-slots.png' });

  // Click "Slice Plate"
  const sliceBtn = page.locator('button:has-text("Slice Plate")').first();
  await sliceBtn.waitFor({ state: 'visible', timeout: 5000 });
  await sliceBtn.click();

  // Wait for slicing to start (button text changes to "Slicing...")
  await page.waitForTimeout(1000);

  // Poll the jobs panel / API until the latest job reaches completed/failed.
  // Backend slicing takes ~30-90s; allow up to 150s.
  let finalStatus: string | null = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(5000);
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/jobs');
      const j = await r.json();
      const latest = j.data?.[0];
      return latest ? { status: latest.status, progress: latest.progress, step: latest.currentStep, error: latest.errorMessage } : null;
    });
    console.log(`poll[${i}]`, res);
    if (res?.status === 'completed' || res?.status === 'failed') {
      finalStatus = res.status;
      break;
    }
  }

  await page.screenshot({ path: 'tests/22-mm-final.png' });

  expect(finalStatus).toBe('completed');

  // Any console errors during the flow? Log them but don't fail unless severe.
  if (errors.length) console.log('CONSOLE ERRORS:', errors);
});
