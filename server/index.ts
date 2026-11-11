import 'dotenv/config';
import { createApp } from './app.js';
import { runBackgroundCycle } from './jobs.js';
import { prisma } from './shared/db.js';
import {
  closeAllStreams,
  closeNotificationBus,
  dispatchPush,
  initNotificationBus,
} from './modules/notification/index.js';
if (
  process.env.NODE_ENV === 'production' &&
  (!process.env.DATABASE_URL ||
    !process.env.PAYMENT_WEBHOOK_SECRET ||
    process.env.DEMO_MODE === 'true' ||
    process.env.PAYMENT_MODE === 'simulated')
)
  throw new Error(
    'Production requires explicit database/provider configuration and disabled demo mode.',
  );
if (!process.env.PAYMENT_WEBHOOK_SECRET || process.env.PAYMENT_WEBHOOK_SECRET.length < 32)
  throw new Error('Set PAYMENT_WEBHOOK_SECRET to at least 32 characters in .env.');
await prisma.$queryRaw`SELECT 1`;
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
initNotificationBus(dispatchPush);
const server = createApp().listen(port, host, () =>
  console.log('Bếp API: http://' + (host === '0.0.0.0' ? 'localhost' : host) + ':' + port),
);
let running = false;
const worker = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await runBackgroundCycle();
  } catch (e) {
    console.error('Worker error', e);
  } finally {
    running = false;
  }
}, 3000);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    clearInterval(worker);
    // Open SSE responses never end on their own; close them so server.close() can finish.
    closeAllStreams();
    server.close(async () => {
      while (running) await new Promise((resolve) => setTimeout(resolve, 50));
      await closeNotificationBus();
      await prisma.$disconnect();
      process.exit(0);
    });
  });
