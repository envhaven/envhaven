import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: process.env.ENVHAVEN_TEST_URL || 'http://localhost:3000',
    headless: true,
    ignoreHTTPSErrors: true,
  },
  projects: [{
    name: 'chromium',
    use: {
      launchOptions: {
        executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome',
        args: ['--no-sandbox', '--disable-gpu'],
      },
    },
  }],
  timeout: 60_000,
});
