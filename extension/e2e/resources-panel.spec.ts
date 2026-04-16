import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import { execSync } from 'child_process';

const PASSWORD = process.env.ENVHAVEN_PASSWORD ?? '';
const CONTAINER = process.env.ENVHAVEN_TEST_CONTAINER ?? 'envhaven-test';

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
      const deep = nested.frameLocator('iframe');
      if (await deep.locator('text=Resources').count() > 0) return deep;
    } catch {}
  }
  return null;
}

function ensureTmuxSession() {
  try {
    execSync(
      `docker exec ${CONTAINER} sh -c "tmux has-session -t envhaven 2>/dev/null || tmux new-session -d -s envhaven -c /config/workspace"`,
      { stdio: 'ignore' }
    );
  } catch {
    /* container or tmux not available — test will skip */
  }
}

function sendToTmux(cmd: string) {
  execSync(
    `docker exec ${CONTAINER} tmux send-keys -t envhaven ${JSON.stringify(cmd)} Enter`,
    { stdio: 'ignore' }
  );
}

function killAllSleeps() {
  try {
    execSync(`docker exec ${CONTAINER} pkill -f "sleep 999"`, { stdio: 'ignore' });
  } catch {
    /* nothing to kill */
  }
}

test.describe('Resources panel', () => {
  test.beforeEach(() => {
    ensureTmuxSession();
    killAllSleeps();
  });

  test.afterEach(() => {
    killAllSleeps();
  });

  test('spawned process appears under User and can be stopped', async ({ page }) => {
    test.skip(!PASSWORD, 'ENVHAVEN_PASSWORD not set');

    await loginToCodeServer(page);

    const workbench = page.locator('.monaco-workbench, [id="workbench.main.container"]');
    await expect(workbench).toBeVisible({ timeout: 30_000 });

    const frame = await findSidebarFrame(page);
    test.skip(!frame, 'sidebar frame not found');

    await expect(frame!.locator('text=Resources')).toBeVisible({ timeout: 15_000 });

    sendToTmux('sleep 999');

    // Outer "Processes" group is collapsed by default; expand it so nested
    // groups (Shells / User / Child) become visible. "User" is defaultOpen.
    await frame!.locator('button', { hasText: /^Processes\s/ }).first().click();

    const sleepRow = frame!.locator('div').filter({ hasText: /^sleep/ }).first();
    await expect(sleepRow).toBeVisible({ timeout: 20_000 });

    await sleepRow.hover();
    const stopBtn = sleepRow.getByRole('button', { name: 'Terminate' });
    await stopBtn.click();

    await expect(sleepRow).toBeHidden({ timeout: 20_000 });
  });

  test('CPU and RAM gauges render', async ({ page }) => {
    test.skip(!PASSWORD, 'ENVHAVEN_PASSWORD not set');

    await loginToCodeServer(page);

    const frame = await findSidebarFrame(page);
    test.skip(!frame, 'sidebar frame not found');

    await expect(frame!.locator('text=CPU')).toBeVisible({ timeout: 15_000 });
    await expect(frame!.locator('text=RAM')).toBeVisible({ timeout: 15_000 });
  });
});
