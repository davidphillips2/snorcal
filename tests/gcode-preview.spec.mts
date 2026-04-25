import { test, expect } from '@playwright/test';

test('gcode preview batman with gcode-preview library', async ({ page }) => {
  test.setTimeout(60000);
  page.on('console', msg => {
    if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text());
  });

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(2000);

  await page.locator('button:has-text("Snapmaker U1")').click();
  await page.waitForTimeout(3000);

  // Open Jobs panel
  await page.locator('button:has-text("Jobs")').click();
  await page.waitForTimeout(500);

  // Click Preview
  const previewBtn = page.locator('button').filter({ hasText: 'Preview' }).first();
  await previewBtn.waitFor({ state: 'visible', timeout: 5000 });
  await previewBtn.click();
  await page.waitForTimeout(8000);

  // Screenshot initial state (all layers)
  await page.screenshot({ path: 'tests/11-gcode-preview-initial.png', fullPage: false });

  // Uncheck "All layers" so we see single layer
  await page.locator('text=All layers').click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'tests/12-gcode-preview-single-layer.png', fullPage: false });

  // Test vertical slider - move to layer 50
  const slider = page.locator('input[type="range"]').first();
  await slider.fill('50');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tests/13-gcode-preview-layer50.png', fullPage: false });

  // Check "All layers" back on
  await page.locator('text=All layers').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tests/14-gcode-preview-all-layers.png', fullPage: false });
});
