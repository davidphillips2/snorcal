import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  workers: 1,            // serialize: all tests share one backend
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
});
