import { Router } from 'express';
import { actor, tokenFrom } from '../../shared/http/actor.js';
import { check } from '../../shared/errors.js';
import { resolveByToken } from '../identity/index.js';
import { authorizedTrackingSnapshot } from './application/driver-tracking.service.js';
import { openTrackingStream } from './application/tracking-stream.service.js';
import { driverWalkingNavigation } from './application/tracking-navigation.service.js';

export const trackingRoutes = Router();
trackingRoutes.get('/orders/:id/tracking', async (req, res) => {
  const result = await authorizedTrackingSnapshot(actor(req), String(req.params.id));
  res.json(result.snapshot);
});
trackingRoutes.get('/orders/:id/tracking/stream', async (req, res) => {
  await openTrackingStream(req, res, actor(req), String(req.params.id));
});

trackingRoutes.get('/orders/:id/tracking/route', async (req, res) => {
  const driver = actor(req, 'DRIVER');
  const route = await driverWalkingNavigation(driver, String(req.params.id), req.query);
  const current = await resolveByToken(tokenFrom(req.headers.cookie));
  check(
    current?.id === driver.id && current.role === 'DRIVER',
    401,
    'UNAUTHENTICATED',
    'Your session has ended.',
  );
  res.json(route);
});
