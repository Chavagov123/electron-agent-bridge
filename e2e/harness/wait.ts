/**
 * Poll `condition` (sync or async) until it yields a value other than `undefined`/`false`.
 * Never a fixed sleep: returns as soon as the condition holds. A condition that throws is retried.
 */
export async function waitFor<T>(
  condition: () => T | undefined | false | Promise<T | undefined | false>,
  { timeoutMs = 10_000, intervalMs = 50, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await condition();
      if (value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      const cause = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
      throw new Error(`${what} not met within ${timeoutMs}ms${cause}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
