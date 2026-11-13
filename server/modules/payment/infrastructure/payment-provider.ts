import { AppError, check } from '../../../shared/errors.js';
import { breaker, retryRead } from '../../../shared/resilience.js';
import * as payments from './payment.repository.js';

export const simulated = () => process.env.PAYMENT_MODE === 'simulated';

// Adapter boundary: a real provider must implement create/query/refund with the same stable reference.
export const paymentAdapter = {
  async create(reference: string, amount: number) {
    check(simulated(), 503, 'PROVIDER_UNAVAILABLE', 'No payment provider is configured.');
    await payments.insertSimulated(reference, amount, 'sim_' + reference);
    return this.query(reference);
  },
  async query(reference: string) {
    return payments.findSimulated(reference);
  },
  async refund(reference: string) {
    check(simulated(), 503, 'PROVIDER_UNAVAILABLE', 'Refund provider is not configured.');
    await payments.refundSimulated(reference);
    return this.query(reference);
  },
};

/** Business or configuration rejections (4xx) do not trip the breaker. */
const countsAsOutage = (error: unknown) => !(error instanceof AppError && error.status < 500);
const paymentBreaker = () => breaker('payment-provider', countsAsOutage);

/**
 * One provider call with a timeout behind the payment breaker. Pass a function
 * so an open breaker skips the call entirely; a started promise is still
 * accepted for older callers. Never retried here: money movement is not
 * retried blindly.
 */
export async function providerCall<T>(work: Promise<T> | (() => Promise<T>)): Promise<T> {
  return paymentBreaker().run(async () => {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        typeof work === 'function' ? work() : work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Payment provider timeout')),
            Number(process.env.PROVIDER_TIMEOUT_MS || 3000),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  });
}

/** Idempotent status read: bounded retries inside a small request budget. */
export async function providerRead<T>(work: () => Promise<T>): Promise<T> {
  return retryRead(() => providerCall(work), {
    budgetMs: 2000,
    retryable: countsAsOutage,
  });
}
