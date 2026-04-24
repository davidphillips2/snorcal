import { test, expect } from '@playwright/test';

test('gcode preview batman with infill + horizontal path slider', async ({ page }) => {
  test.setTimeout(60000);
  const logs: string[] = [];
  page.on('console', msg => logs.push(msg.text()));

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(2000);

  await page.locator('button:has-text("Snapmaker U1")').click();
  await page.waitForTimeout(3000);

  // Click Preview
  const previewBtn = page.locator('button').filter({ hasText: 'Preview' }).first();
  await previewBtn.waitFor({ state: 'visible', timeout: 5000 });
  await previewBtn.click();
  await page.waitForTimeout(12000);

  // Screenshot initial state (all layers, default hidden types)
  await page.screenshot({ path: 'tests/04-gcode-initial.png', fullPage: false });

  // Uncheck "All layers" so we see single layer + horizontal path slider
  await page.locator('text=All layers').click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'tests/05-gcode-single-layer.png', fullPage: false });

  // Enable infill checkbox
  const infillCheckbox = page.locator('label').filter({ hasText: 'Infill' }).locator('input[type="checkbox"]');
  await infillCheckbox.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tests/06-gcode-infill-on.png', fullPage: false });

  // Test vertical slider - move to layer 50
  const sliders = page.locator('input[type="range"]');
  const verticalSlider = sliders.first(); // vertical layer slider
  await verticalSlider.fill('50');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tests/07-gcode-layer50.png', fullPage: false });

  // Test horizontal path slider - should be 2nd range input
  const horizontalSlider = sliders.nth(1);
  await horizontalSlider.waitFor({ state: 'visible', timeout: 3000 });
  // Move to 25% of path
  await horizontalSlider.fill('100');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tests/09-gcode-path-partial.png', fullPage: false });

  // Move path slider to ~50%
  await horizontalSlider.fill('200');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tests/10-gcode-path-half.png', fullPage: false });

  // Check "All layers" back on — horizontal slider should disappear
  await page.locator('text=All layers').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tests/08-gcode-all-infill.png', fullPage: false });
});
