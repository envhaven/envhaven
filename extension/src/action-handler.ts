export async function runHandledAction(
  action: () => Promise<unknown> | unknown,
  report: (error: unknown) => Promise<unknown> | unknown
): Promise<void> {
  try {
    await action();
  } catch (error) {
    await report(error);
  }
}
