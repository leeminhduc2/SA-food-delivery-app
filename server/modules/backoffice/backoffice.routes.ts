import { Router } from 'express';
import { actor } from '../../shared/http/actor.js';
import * as admin from './admin.service.js';
import * as reports from './report.service.js';

export const backofficeRoutes = Router();

backofficeRoutes.get('/reports', async (req, res) => {
  res.json(await reports.report(actor(req, 'ADMIN', 'RESTAURANT')));
});

backofficeRoutes.get('/admin/overview', async (req, res) => {
  actor(req, 'ADMIN');
  res.json(await admin.overview());
});

backofficeRoutes.patch('/admin/users/:id', async (req, res) => {
  const administrator = actor(req, 'ADMIN');
  await admin.setUserActive(administrator, String(req.params.id), req.body, req.requestId);
  res.json({ ok: true });
});
