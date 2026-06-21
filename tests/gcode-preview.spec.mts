import { test, expect } from '@playwright/test';

test('gcode preview batman with gcode-preview library', async ({ page }) => {
  test.setTimeout(90000);
  page.on('console', msg => {
    if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text());
  });

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(2000);

  // Slice view + sidebar Jobs panel (matches pause-at-layer test flow).
  // Skip onboarding: backend should already have a registered printer.
  await page.locator('button:has-text("slice")').first().click();
  await page.waitForTimeout(1500);

  // Expand Jobs (N) section in sidebar
  await page.locator('button').filter({ hasText: /^Jobs \(\d+\)/ }).first().click();
  await page.waitForTimeout(800);

  // Click Preview on first completed job
  const previewBtn = page.locator('button:has-text("Preview")').first();
  await previewBtn.waitFor({ state: 'visible', timeout: 5000 });
  await previewBtn.click();

  // Wait for slider to appear (gcode fetched + parsed)
  await page.locator('input[type="range"]').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForTimeout(2000);

  // Screenshot initial state (all layers)
  await page.screenshot({ path: 'tests/11-gcode-preview-initial.png', fullPage: false });

  // Uncheck "All layers" so we see single layer
  await page.locator('text=All layers').click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'tests/12-gcode-preview-single-layer.png', fullPage: false });

  // Test vertical slider - move to layer 50
  // React's onChange fires from native input events — set value + dispatch
  // both 'input' and 'change' so the SyntheticEvent fires reliably.
  const slider = page.locator('input[type="range"]').first();
  await slider.evaluate((el: HTMLInputElement, val) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, String(val));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, 50);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tests/13-gcode-preview-layer50.png', fullPage: false });

  // Check "All layers" back on
  await page.locator('text=All layers').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tests/14-gcode-preview-all-layers.png', fullPage: false });
});
