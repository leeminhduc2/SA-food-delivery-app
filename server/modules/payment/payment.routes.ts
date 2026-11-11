import { Router } from 'express';
import { check } from '../../shared/errors.js';
import { handleWebhook } from './application/webhook.js';

/** Mounted before express.json so HMAC verification sees the exact raw bytes. */
export const paymentRoutes = Router();

paymentRoutes.post('/webhook', async (req, res) => {
  check(Buffer.isBuffer(req.body), 400, 'INVALID_BODY', 'Expected a JSON payment callback.');
  const raw = (req.body as Buffer).toString('utf8');
  const given = String(req.headers['x-payment-signature'] || '');
  res.json(await handleWebhook(raw, given, req.requestId));
});
