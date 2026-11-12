import { Router } from 'express';
import { actor } from '../../shared/http/actor.js';
import {
  getAvailability,
  heartbeat,
  updateAvailability,
} from './application/availability.service.js';
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
