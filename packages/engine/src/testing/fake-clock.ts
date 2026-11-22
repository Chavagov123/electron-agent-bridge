import type { Clock } from '../ports/clock.js';

/** A clock that only moves when slept on: retries and timeouts run instantly and deterministically. */
export class FakeClock implements Clock {
  #now = 1_000;

  now(): number {
    return this.#now;
  }

  sleep(ms: number): Promise<void> {
    this.#now += ms;
    return Promise.resolve();
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}
