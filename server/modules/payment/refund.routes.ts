import { Router } from 'express';
import { actor } from '../../shared/http/actor.js';
import * as refunds from './application/refund.service.js';

/** JSON routes; the webhook router keeps its raw body parser separately. */
export const refundRoutes = Router();

refundRoutes.post('/orders/:id/refund-requests', async (req, res) => {
  res
    .status(201)
    .json(
      await refunds.requestRefund(actor(req, 'CUSTOMER', 'ADMIN'), String(req.params.id), req.body),
    );
});

refundRoutes.get('/orders/:id/refund-requests', async (req, res) => {
  res.json(await refunds.listForOrder(actor(req, 'CUSTOMER', 'ADMIN'), String(req.params.id)));
});

refundRoutes.get('/admin/refund-requests', async (req, res) => {
  res.json(await refunds.listForAdmin(actor(req, 'ADMIN'), req.query));
});

refundRoutes.post('/admin/refund-requests/:id/decision', async (req, res) => {
  res.json(await refunds.decideRefund(actor(req, 'ADMIN'), String(req.params.id), req.body));
});

refundRoutes.post('/admin/refund-requests/:id/retry', async (req, res) => {
  res.json(await refunds.retryRefund(actor(req, 'ADMIN'), String(req.params.id), req.body));
});
