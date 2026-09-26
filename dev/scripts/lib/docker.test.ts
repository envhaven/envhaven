import { expect, test } from 'bun:test';
import { runBoundedProcess } from './docker';

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
