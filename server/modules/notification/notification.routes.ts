import { Router } from 'express';
import { actor } from '../../shared/http/actor.js';
import { AppError } from '../../shared/errors.js';
import * as notifications from './notification.service.js';
import { notificationBus } from './notification.bus.js';
import { canOpenStream, openStream } from './notification.stream.js';

export const notificationRoutes = Router();

notificationRoutes.get('/notifications', async (req, res) => {
  res.json(await notifications.inbox(actor(req)));
});

notificationRoutes.get('/notifications/stream', async (req, res) => {
  const user = actor(req);
  if (!notificationBus())
    throw new AppError(503, 'STREAM_DISABLED', 'Live notifications are not configured.');
  if (canOpenStream(user.id) !== 'ok')
    throw new AppError(429, 'TOO_MANY_STREAMS', 'Too many open notification streams.');
  await openStream(req, res, user.id, notifications.replaySince);
});

notificationRoutes.post('/notifications/read', async (req, res) => {
  await notifications.markRead(actor(req));
  res.json({ ok: true });
});
