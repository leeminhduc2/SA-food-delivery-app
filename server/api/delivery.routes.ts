import { Router } from 'express';
import * as delivery from '../services/delivery.service.js';
import { actor } from './middleware/actor.js';

export const deliveryRoutes = Router();

deliveryRoutes.post('/deliveries/:id/assign', async (req, res) => {
  await delivery.assign(actor(req, 'ADMIN'), String(req.params.id), req.body);
  res.json({ ok: true });
});

deliveryRoutes.post('/deliveries/:id/transition', async (req, res) => {
  await delivery.transition(actor(req, 'DRIVER'), String(req.params.id), req.body);
  res.json({ ok: true });
});
