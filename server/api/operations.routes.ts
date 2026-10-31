import { Router } from 'express';
import * as admin from '../services/admin.service.js';
import * as catalog from '../services/catalog.service.js';
import * as notifications from '../services/notification.service.js';
import * as reports from '../services/report.service.js';
import * as reviews from '../services/review.service.js';
import * as support from '../services/support.service.js';
import { actor } from './middleware/actor.js';

export const operationsRoutes = Router();

operationsRoutes.post('/orders/:id/review', async (req, res) => {
  const customer = actor(req, 'CUSTOMER');
  res.status(201).json(await reviews.create(customer, String(req.params.id), req.body));
});

operationsRoutes.post('/orders/:id/complaints', async (req, res) => {
  const customer = actor(req, 'CUSTOMER');
  res.status(201).json(await support.createComplaint(customer, String(req.params.id), req.body));
});

operationsRoutes.get('/complaints', async (req, res) => {
  res.json(await support.list(actor(req, 'CUSTOMER', 'ADMIN')));
});

operationsRoutes.get('/notifications', async (req, res) => {
  res.json(await notifications.inbox(actor(req)));
});

operationsRoutes.post('/notifications/read', async (req, res) => {
  await notifications.markRead(actor(req));
  res.json({ ok: true });
});

operationsRoutes.get('/reports', async (req, res) => {
  res.json(await reports.report(actor(req, 'ADMIN', 'RESTAURANT')));
});

operationsRoutes.get('/admin/overview', async (req, res) => {
  actor(req, 'ADMIN');
  res.json(await admin.overview());
});

operationsRoutes.post('/admin/restaurants/:id/approval', async (req, res) => {
  const administrator = actor(req, 'ADMIN');
  await catalog.setApproval(administrator, String(req.params.id), req.body);
  res.json({ ok: true });
});

operationsRoutes.patch('/admin/users/:id', async (req, res) => {
  const administrator = actor(req, 'ADMIN');
  await admin.setUserActive(administrator, String(req.params.id), req.body);
  res.json({ ok: true });
});

operationsRoutes.post('/admin/complaints/:id/resolve', async (req, res) => {
  const administrator = actor(req, 'ADMIN');
  await support.resolve(administrator, String(req.params.id), req.body);
  res.json({ ok: true });
});

operationsRoutes.patch('/admin/reviews/:id', async (req, res) => {
  const administrator = actor(req, 'ADMIN');
  await reviews.moderate(administrator, String(req.params.id), req.body);
  res.json({ ok: true });
});
