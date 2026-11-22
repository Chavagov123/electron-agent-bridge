/** Time, injected so waits and retries are testable without real delays. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
