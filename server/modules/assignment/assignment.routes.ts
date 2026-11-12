import { Router } from 'express';
import { actor } from '../../shared/http/actor.js';
import {
  getAvailability,
  heartbeat,
  updateAvailability,
} from './application/availability.service.js';
import { respondToOffer } from './application/offer-response.service.js';
export const assignmentRoutes = Router();
assignmentRoutes.get('/driver/availability', async (req, res) =>
  res.json(await getAvailability(actor(req, 'DRIVER').id)),
);
assignmentRoutes.patch('/driver/availability', async (req, res) =>
  res.json(await updateAvailability(actor(req, 'DRIVER').id, req.body)),
);
assignmentRoutes.post('/driver/heartbeat', async (req, res) =>
  res.json(await heartbeat(actor(req, 'DRIVER').id)),
);
assignmentRoutes.post('/driver/offers/:id/accept', async (req, res) =>
  res.json(
    await respondToOffer(
      actor(req, 'DRIVER'),
      String(req.params.id),
      req.body,
      'ACCEPTED',
      req.requestId,
    ),
  ),
);
assignmentRoutes.post('/driver/offers/:id/reject', async (req, res) =>
  res.json(
    await respondToOffer(
      actor(req, 'DRIVER'),
      String(req.params.id),
      req.body,
      'REJECTED',
      req.requestId,
    ),
  ),
);
