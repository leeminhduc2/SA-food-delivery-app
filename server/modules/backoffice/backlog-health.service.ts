import { transaction } from '../../shared/db.js';
import { stageStatuses } from '../../shared/job-status.js';
import { breakerSnapshots } from '../../shared/resilience.js';
import { activeAdministratorIds } from '../identity/index.js';
import { notifyOnce } from '../notification/index.js';
import { backlogRows } from './backlog-health.projection.js';

/** A queue is overdue when its next retry is more than this late. */
const OVERDUE_MS = 5 * 60 * 1000;

export async function backlogHealth(now = new Date()) {
  const queues = (await backlogRows()).map((row) => {
    const overdue =
      row.pending > 0 &&
      row.nextRunAt !== null &&
      now.getTime() - row.nextRunAt.getTime() > OVERDUE_MS;
    return { ...row, overdue, needsAttention: overdue || row.failed > 0 };
  });
  return {
    asOf: now.toISOString(),
    queues,
    breakers: breakerSnapshots(),
    stages: stageStatuses(),
    note: 'Breaker and stage state are per process; queue counts come from the database.',
  };
}

/**
 * Background stage: one Admin notification per queue and hour while it needs
 * attention, so a stuck queue is visible without flooding inboxes.
 */
export async function alertBacklog(now = new Date()): Promise<number> {
  const health = await backlogHealth(now);
  const hour = now.toISOString().slice(0, 13);
  let sent = 0;
  for (const queue of health.queues.filter((item) => item.needsAttention))
    await transaction(async (db) => {
      for (const adminId of await activeAdministratorIds(db)) {
        await notifyOnce(
          db,
          adminId,
          'BACKLOG_ATTENTION',
          { queue: queue.queue, failed: queue.failed, overdue: queue.overdue },
          `${queue.queue}:${hour}`,
        );
        sent++;
      }
    });
  return sent;
}
