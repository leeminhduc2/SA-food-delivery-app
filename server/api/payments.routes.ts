import { Router } from 'express';
import { check } from '../domain/errors.js';
import * as payments from '../services/payment.service.js';
import { actor } from './middleware/actor.js';

/** Mounted before express.json so HMAC verification sees the exact raw bytes. */
export const paymentRoutes = Router();

paymentRoutes.post('/webhook', async (req, res) => {
  check(Buffer.isBuffer(req.body), 400, 'INVALID_BODY', 'Expected a JSON payment callback.');
  const raw = (req.body as Buffer).toString('utf8');
  const given = String(req.headers['x-payment-signature'] || '');
  res.json(await payments.handleWebhook(raw, given, req.requestId));
});

export const paymentActionRoutes = Router();

paymentActionRoutes.post('/orders/:id/simulate-payment', async (req, res) => {
  const customer = actor(req, 'CUSTOMER');
  res.json(await payments.simulate(customer, String(req.params.id), req.body));
});
