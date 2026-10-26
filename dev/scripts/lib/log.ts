import { $ } from 'bun';

const isTTY = process.stdout.isTTY ?? false;

const colors = {
  reset: isTTY ? '\x1b[0m' : '',
  dim: isTTY ? '\x1b[2m' : '',
  red: isTTY ? '\x1b[31m' : '',
  green: isTTY ? '\x1b[32m' : '',
  yellow: isTTY ? '\x1b[33m' : '',
  cyan: isTTY ? '\x1b[36m' : '',
};

export const log = {
  info: (msg: string) => console.log(`${colors.cyan}→${colors.reset} ${msg}`),
  success: (msg: string) => console.log(`${colors.green}✓${colors.reset} ${msg}`),
  error: (msg: string) => console.error(`${colors.red}✗${colors.reset} ${msg}`),
  warn: (msg: string) => console.log(`${colors.yellow}!${colors.reset} ${msg}`),
  dim: (msg: string) => console.log(`${colors.dim}${msg}${colors.reset}`),
  command: (msg: string) => console.log(`${colors.dim}$ ${msg}${colors.reset}`),
  header: (msg: string) => console.log(`\n${colors.cyan}━━━ ${msg} ━━━${colors.reset}`),
  plain: (msg: string) => console.log(msg),
  newline: () => console.log(''),
};

/**
 * Runs one named step of a script. A failure logs the step with what its command printed, so it
 * says what to fix; stdout counts as well as stderr, because tsc writes its errors there.
 * Returns whether the step succeeded, and leaves going on or exiting to the caller.
 */
export async function runStep(name: string, run: () => Promise<unknown>): Promise<boolean> {
  log.info(`${name}...`);
  try {
    await run();
    return true;
  } catch (error) {
    const printed = error instanceof $.ShellError
      ? [error.stdout, error.stderr].map((out) => out.toString().trim()).filter(Boolean).join('\n')
      : '';
    log.error(`${name} failed: ${printed || (error instanceof Error ? error.message : String(error))}`);
    return false;
  }
}

export function formatTestSummary(passed: number, failed: number): void {
  log.newline();
  log.header('Test Summary');
  log.plain(`Passed: ${colors.green}${passed}${colors.reset}`);
  log.plain(`Failed: ${colors.red}${failed}${colors.reset}`);
  log.newline();
  
  if (failed === 0) {
    log.success('All tests passed!');
  } else {
    log.error(`${failed} test(s) failed`);
  }
}
