import { Router } from 'express';
import * as delivery from './application/delivery.service.js';
import { actor } from '../../shared/http/actor.js';
import { history } from './application/driver-history.service.js';
import { getDriverOverride } from './delivery.ports.js';
import { verifyOtpProof } from './application/delivery-proof.service.js';

export const deliveryRoutes = Router();

deliveryRoutes.post('/deliveries/:id/proofs/otp', async (req, res) => {
  res.json(await verifyOtpProof(actor(req, 'DRIVER'), String(req.params.id), req.body));
});

deliveryRoutes.post('/deliveries/:id/arrive', async (req, res) => {
  res.json(await delivery.arrive(actor(req, 'DRIVER'), String(req.params.id), req.body));
});

deliveryRoutes.get('/driver/deliveries/history', async (req, res) => {
  res.json(await history(actor(req, 'DRIVER').id, req.query));
});

deliveryRoutes.post('/deliveries/:id/assign', async (req, res) => {
  res.json(
    await getDriverOverride()(actor(req, 'ADMIN'), String(req.params.id), req.body, req.requestId),
  );
});

deliveryRoutes.post('/deliveries/:id/transition', async (req, res) => {
  await delivery.transition(actor(req, 'DRIVER'), String(req.params.id), req.body);
  res.json({ ok: true });
});
