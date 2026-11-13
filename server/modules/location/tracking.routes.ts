import { Router } from 'express';
import { actor } from '../../shared/http/actor.js';
import { authorizedTrackingSnapshot } from './application/driver-tracking.service.js';
import { openTrackingStream } from './application/tracking-stream.service.js';

export const trackingRoutes = Router();
trackingRoutes.get('/orders/:id/tracking', async (req, res) => {
  const result = await authorizedTrackingSnapshot(actor(req), String(req.params.id));
  res.json(result.snapshot);
});
trackingRoutes.get('/orders/:id/tracking/stream', async (req, res) => {
  await openTrackingStream(req, res, actor(req), String(req.params.id));
});
