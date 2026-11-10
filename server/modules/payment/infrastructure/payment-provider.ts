import { check } from '../../../shared/errors.js';
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

export async function providerCall<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
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
}
