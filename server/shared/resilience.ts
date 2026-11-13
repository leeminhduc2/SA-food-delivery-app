import { z } from 'zod';

const positive = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive());
const configSchema = z.object({
  EXTERNAL_BREAKER_FAILURES: positive.default(5),
  EXTERNAL_BREAKER_OPEN_SECONDS: positive.default(30),
});
export function parseResilienceConfig(env: Record<string, string | undefined>) {
  return configSchema.parse(env);
}
export const resilienceConfig = parseResilienceConfig(process.env);

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';
  constructor(readonly provider: string) {
    super(`${provider} is temporarily unavailable.`);
  }
}

export type CircuitBreaker = {
  readonly name: string;
  run<T>(work: () => Promise<T>): Promise<T>;
  snapshot(): {
    name: string;
    state: BreakerState;
    consecutiveFailures: number;
    openedAt: string | null;
    retryAt: string | null;
  };
};

/**
 * Per-provider, per-process breaker. Five consecutive counted failures open it
 * for 30 s; then exactly one probe runs while other callers fail fast. A probe
 * success closes it; a counted probe failure opens it again. Errors for which
 * `counts` returns false (validation, 4xx, "no route") never trip it. State is
 * local to this process; it is not distributed resilience.
 */
export function createCircuitBreaker(
  name: string,
  options: {
    failureThreshold?: number;
    openMs?: number;
    now?: () => number;
    counts?: (error: unknown) => boolean;
  } = {},
): CircuitBreaker {
  const threshold = options.failureThreshold ?? resilienceConfig.EXTERNAL_BREAKER_FAILURES;
  const openMs = options.openMs ?? resilienceConfig.EXTERNAL_BREAKER_OPEN_SECONDS * 1000;
  const now = options.now ?? Date.now;
  const counts = options.counts ?? (() => true);
  let state: BreakerState = 'CLOSED',
    failures = 0,
    openedAt = 0,
    probing = false;
  const current = (): BreakerState => {
    if (state === 'OPEN' && now() >= openedAt + openMs) state = 'HALF_OPEN';
    return state;
  };
  const open = () => {
    state = 'OPEN';
    openedAt = now();
  };
  return {
    name,
    async run(work) {
      const phase = current();
      if (phase === 'OPEN' || (phase === 'HALF_OPEN' && probing)) throw new CircuitOpenError(name);
      const probe = phase === 'HALF_OPEN';
      if (probe) probing = true;
      try {
        const result = await work();
        state = 'CLOSED';
        failures = 0;
        return result;
      } catch (error) {
        if (!counts(error)) {
          // The provider answered; a business rejection proves it is reachable.
          if (probe) state = 'CLOSED';
          failures = 0;
        } else if (probe) open();
        else if (++failures >= threshold) open();
        throw error;
      } finally {
        if (probe) probing = false;
      }
    },
    snapshot() {
      const phase = current();
      return {
        name,
        state: phase,
        consecutiveFailures: failures,
        openedAt: phase === 'CLOSED' ? null : new Date(openedAt).toISOString(),
        retryAt: phase === 'OPEN' ? new Date(openedAt + openMs).toISOString() : null,
      };
    },
  };
}

const registry = new Map<string, CircuitBreaker>();

/** Shared breaker per provider name, created on first use. */
export function breaker(name: string, counts?: (error: unknown) => boolean): CircuitBreaker {
  let existing = registry.get(name);
  if (!existing) {
    existing = createCircuitBreaker(name, { counts });
    registry.set(name, existing);
  }
  return existing;
}

export function breakerSnapshots() {
  return [...registry.values()].map((item) => item.snapshot());
}

/** A replaced provider starts with a fresh breaker. */
export function resetBreaker(name: string): void {
  registry.delete(name);
}

/** Test seam: forget every breaker so the next call starts CLOSED. */
export function resetBreakers(): void {
  registry.clear();
}

/**
 * Bounded retries for idempotent reads only (never money movement): up to two
 * retries after 250 ms and 500 ms plus up to 100 ms jitter, and never past the
 * request budget. An open breaker is not retried.
 */
export async function retryRead<T>(
  work: () => Promise<T>,
  options: {
    budgetMs?: number;
    delaysMs?: readonly number[];
    jitterMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
    retryable?: (error: unknown) => boolean;
  } = {},
): Promise<T> {
  const delays = options.delaysMs ?? [250, 500];
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const retryable = options.retryable ?? (() => true);
  const deadline = now() + (options.budgetMs ?? 2000);
  for (let attempt = 0; ; attempt++) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof CircuitOpenError || !retryable(error) || attempt >= delays.length)
        throw error;
      const wait = delays[attempt] + Math.floor(random() * ((options.jitterMs ?? 100) + 1));
      if (now() + wait > deadline) throw error;
      await sleep(wait);
    }
  }
}
