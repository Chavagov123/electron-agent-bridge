/** What {@link withDeadline} gives when the work took longer than allowed. */
export const LATE: unique symbol = Symbol('late');

/**
 * The work's result; `undefined` when it failed; {@link LATE} when it took longer than `ms`. The work
 * itself goes on (nothing can cancel a promise); its result is then dropped. The timer never keeps the
 * process alive.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | undefined | typeof LATE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => {
      resolve(LATE);
    }, ms);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work.catch(() => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
}
