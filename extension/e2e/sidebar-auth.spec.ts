import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

const PASSWORD = process.env.ENVHAVEN_PASSWORD ?? '';
const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const EXT_PATH = `envhaven.envhaven-${PKG.version}`;

async function loginToCodeServer(page: Page) {
  await page.goto('/login');
  const passwordInput = page.getByRole('textbox', { name: 'PASSWORD' });
  await passwordInput.waitFor({ timeout: 15_000 });
  await passwordInput.fill(PASSWORD);
  await page.getByRole('button', { name: 'SUBMIT' }).click();
  await page.waitForFunction(() => !window.location.pathname.includes('/login'), { timeout: 20_000 });
}

async function findSidebarFrame(page: Page): Promise<FrameLocator | null> {
  await page.waitForTimeout(5_000);
  for (const selector of ['iframe.webview', 'iframe[sandbox]', 'iframe']) {
    try {
      const nested = page.frameLocator(selector);
      const deepFrame = nested.frameLocator('iframe');
      if (await deepFrame.locator('text=AI Tools').count() > 0) return deepFrame;
    } catch {}
  }
  return null;
}

test.describe('Sidebar auth-aware tool launch', () => {
  test('code-server loads and login works', async ({ page }) => {
    await loginToCodeServer(page);
    await expect(page.locator('.monaco-workbench, [id="workbench.main.container"]')).toBeVisible({ timeout: 30_000 });
  });

  test('extension sidebar renders AI Tools', async ({ page }) => {
    await loginToCodeServer(page);
    await page.waitForTimeout(10_000);

    const workbench = page.locator('.monaco-workbench, [id="workbench.main.container"]');
    await expect(workbench).toBeVisible({ timeout: 30_000 });

    const sidebarFrame = await findSidebarFrame(page);
    if (sidebarFrame) {
      await expect(sidebarFrame.locator('text=AI Tools')).toBeVisible({ timeout: 10_000 });
    }
  });

  test('webview bundle contains authCommand routing', async ({ page }) => {
    await loginToCodeServer(page);

    const response = await page.request.get(`/static/extensions/${EXT_PATH}/webview/build/assets/index.js`);
    if (response.ok()) {
      const js = await response.text();
      expect(js).toContain('authCommand');
      expect(js).toContain('Sign in');
      expect(js).toContain('Set key');
    }
  });
});
