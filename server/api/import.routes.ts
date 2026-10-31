import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import * as imports from '../services/restaurant-import.service.js';
import { actor } from './middleware/actor.js';

export const importRoutes = Router();

const importLimiter = rateLimit({ windowMs: 60000, limit: 5 });

/** Queue an OSM import and return the job immediately; the work runs in-process. */
importRoutes.post('/admin/restaurants/import', importLimiter, async (req, res) => {
  const administrator = actor(req, 'ADMIN');
  const job = await imports.queueRestaurantImport(administrator, req.body);
  res.status(202).json({ jobId: job.id, status: job.status, dryRun: job.dry_run });
});

importRoutes.get('/admin/restaurants/import/history', async (req, res) => {
  actor(req, 'ADMIN');
  res.json(await imports.importHistory(req.query.limit));
});
