import { Router } from 'express';
import { actor } from '../../shared/http/actor.js';
import * as notifications from './notification.service.js';

export const notificationRoutes = Router();

notificationRoutes.get('/notifications', async (req, res) => {
  res.json(await notifications.inbox(actor(req)));
});

notificationRoutes.post('/notifications/read', async (req, res) => {
  await notifications.markRead(actor(req));
  res.json({ ok: true });
});
