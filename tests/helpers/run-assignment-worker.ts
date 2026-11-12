import { registerModules } from '../../server/modules/index.js';
import { runAssignmentWorker } from '../../server/modules/assignment/index.js';
import { prisma } from '../../server/shared/db.js';
try {
  registerModules();
  const processed = await runAssignmentWorker(true, 1);
  if (processed !== 1) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
