import { describe, expect, mock, test } from 'bun:test';
import { runHandledAction } from '../action-handler';

describe('runHandledAction', () => {
  test('reports a rejected action exactly once and resolves', async () => {
    const error = new Error('tmux failed');
    const report = mock(async (_error: unknown) => {});

    await expect(runHandledAction(() => Promise.reject(error), report)).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(error);
  });

  test('does not report a successful action', async () => {
    const report = mock(async (_error: unknown) => {});

    await runHandledAction(async () => {}, report);
    expect(report).not.toHaveBeenCalled();
  });
});
