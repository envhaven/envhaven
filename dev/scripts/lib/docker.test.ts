import { expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname } from 'path';
import { runBoundedProcess, withEnvFile } from './docker';

test('withEnvFile writes each variable verbatim into a file only its owner can read', async () => {
  let envFile = '';
  // Spaces, quotes, `=` and `#` all survive: docker takes everything after the first `=` as is.
  const result = await withEnvFile({ PASSWORD: ' p@ss "w=rd" #1 ', SUDO_PASSWORD: 'x' }, async (path) => {
    envFile = path;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, 'utf8')).toBe('PASSWORD= p@ss "w=rd" #1 \nSUDO_PASSWORD=x\n');
    return 'started';
  });

  expect(result).toBe('started');
  expect(existsSync(dirname(envFile))).toBe(false);
});

test('withEnvFile deletes the file when the command fails', async () => {
  let envFile = '';
  const failing = withEnvFile({ PASSWORD: 'x' }, async (path) => {
    envFile = path;
    throw new Error('docker run failed');
  });

  await expect(failing).rejects.toThrow('docker run failed');
  expect(envFile).not.toBe('');
  expect(existsSync(dirname(envFile))).toBe(false);
});

test('withEnvFile refuses a value with a line break before writing anything', async () => {
  let ran = false;
  const injected = withEnvFile({ PASSWORD: 'first\nINJECTED=1' }, async () => {
    ran = true;
  });

  await expect(injected).rejects.toThrow('PASSWORD contains a line break');
  expect(ran).toBe(false);
});

test('runBoundedProcess captures successful output', async () => {
  const result = await runBoundedProcess(
    [process.execPath, '-e', 'console.log("bounded")'],
    1_000
  );

  expect(result).toEqual({ success: true, output: 'bounded' });
});

test('runBoundedProcess kills a hung subprocess at its deadline', async () => {
  const startedAt = Date.now();
  const result = await runBoundedProcess(
    [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    100
  );

  expect(result.success).toBe(false);
  expect(result.output).toContain('Process timed out after 100ms');
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});
