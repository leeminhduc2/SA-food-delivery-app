import type { User } from '../domain/types.js';
import * as reports from '../repositories/report.repository.js';

export async function report(actor: User): Promise<any> {
  const summary = await reports.summary(actor.role, actor.id);
  const daily = await reports.daily(actor.role, actor.id);
  return {
    ...summary,
    daily,
    revenueBasis:
      'Gross order value including delivery fees, delivered orders only; grouped by order creation date (database UTC).',
  };
}
