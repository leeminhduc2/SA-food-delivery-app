import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import * as address from '../services/address.service.js';
import { actor } from '../shared/http/actor.js';

export const addressRoutes = Router();

const resolveLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

addressRoutes.get('/users/me/delivery-address', async (req, res) => {
  res.json(await address.getDefault(actor(req)));
});

addressRoutes.put('/users/me/delivery-address', async (req, res) => {
  res.json(await address.saveDefault(actor(req), req.body));
});

// Preview endpoints are used by the Settings map before the address is saved.
addressRoutes.post('/geocode', resolveLimit, async (req, res) => {
  actor(req);
  res.json(await address.resolveForPreview(req.body));
});

addressRoutes.post('/geocode/reverse', resolveLimit, async (req, res) => {
  actor(req);
  const { latitude, longitude } = req.body || {};
  res.json(await address.resolveForPreview({ latitude, longitude }));
});
