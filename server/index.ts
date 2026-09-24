import 'dotenv/config';
import { createApp } from './app.js';
import { pool } from './db.js';
import { deliverNotifications } from './modules/operations.js';
import { reconcilePayments } from './modules/payments.js';
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
await pool.query('SELECT 1');
const server = createApp().listen(Number(process.env.PORT || 3001), '127.0.0.1', () =>
  console.log('Bếp API: http://localhost:' + (process.env.PORT || 3001)),
);
let running = false;
const worker = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await reconcilePayments();
    await deliverNotifications();
    await pool.query('DELETE FROM sessions WHERE expires_at<now()');
  } catch (e) {
    console.error('Worker error', e);
  } finally {
    running = false;
  }
}, 3000);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    clearInterval(worker);
    server.close(async () => {
      while (running) await new Promise((resolve) => setTimeout(resolve, 50));
      await pool.end();
      process.exit(0);
    });
  });
