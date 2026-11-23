import { defineConfig, devices } from '@playwright/test';

const PORT = 8799;
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.js/,
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, channel: 'chrome', trace: 'retain-on-failure' },
  webServer: { command: `PORT=${PORT} node tests/e2e/server.js`, url: `http://127.0.0.1:${PORT}/`, reuseExistingServer: false, timeout: 30_000 },
  projects: [
    { name: 'desktop-1920', use: { viewport: { width: 1920, height: 1080 } } },
    { name: 'laptop-1366', use: { viewport: { width: 1366, height: 768 } } },
    { name: 'tablet-768', use: { viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true } },
    { name: 'phone-390', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } },
    { name: 'phone-320', use: { viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } },
  ],
});
