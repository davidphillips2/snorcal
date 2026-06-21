import { test, expect } from '@playwright/test';

// Regression for issue #93: inventory routes were returning raw values
// instead of {ok,data} envelope, so apiFetch threw "Unknown error" and the
// inventory panel silently failed to load. Verifies GET + CREATE round-trip.
test('inventory panel lists + creates spool', async ({ page }) => {
  test.setTimeout(60000);

  page.on('pageerror', err => console.log('[PAGEERROR]', err.message));

  // Clean slate via API
  const apiBase = 'http://localhost:3000/api';
  const initial = await (await fetch(`${apiBase}/inventory/spools`)).json();
  for (const s of initial.data) {
    await fetch(`${apiBase}/inventory/spools/${s.id}`, { method: 'DELETE' });
  }

  await page.goto('http://localhost:5173');
  await page.waitForTimeout(1500);

  // Sidebar "inventory" button lives under Target printer picker — needs sidebar visible.
  // Slice view shows the sidebar by default.
  await page.locator('button:has-text("slice")').first().click();
  await page.waitForTimeout(1000);

  await page.locator('button:has-text("inventory")').first().click();
  await page.waitForTimeout(1000);

  await page.screenshot({ path: 'tests/40-inventory-empty.png' });

  // Click "+ Spool"
  await page.locator('button:has-text("+ Spool")').first().click();
  await page.waitForTimeout(500);

  // Editor is a modal with Field label-wrapped inputs (no placeholders).
  // Name field is the first text input inside the modal.
  const modal = page.locator('.fixed.inset-0').last();
  await modal.locator('input[type="text"]').fill('Test PLA');
  await modal.locator('input[type="number"]').first().fill('1000');
  await page.waitForTimeout(300);

  await page.screenshot({ path: 'tests/41-inventory-form.png' });

  // Save button is inside the modal
  await modal.locator('button:has-text("Save")').click();
  await page.waitForTimeout(1500);

  await page.screenshot({ path: 'tests/42-inventory-created.png' });

  // Verify via API that spool persisted
  const after = await (await fetch(`${apiBase}/inventory/spools`)).json();
  expect(after.data.length, 'spool should be persisted').toBe(1);
  expect(after.data[0].name).toBe('Test PLA');

  // Cleanup
  await fetch(`${apiBase}/inventory/spools/${after.data[0].id}`, { method: 'DELETE' });

  await page.screenshot({ path: 'tests/43-inventory-clean.png' });
});
