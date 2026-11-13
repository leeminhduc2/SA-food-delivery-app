import { Router } from 'express';
import { actor } from '../../shared/http/actor.js';
import * as admin from './admin.service.js';
import * as reports from './report.service.js';
import { monitoringPage } from './assignment-monitoring.projection.js';
import { operationalAlerts, operationalSummary } from './operational-monitoring.projection.js';
import { acknowledgeAlert } from './operational-alert.service.js';

export const backofficeRoutes = Router();

backofficeRoutes.get('/admin/monitoring/summary', async (req, res) => {
  actor(req, 'ADMIN');
  res.json(await operationalSummary());
});
backofficeRoutes.get('/admin/alerts', async (req, res) => {
  actor(req, 'ADMIN');
  res.json({ items: await operationalAlerts() });
});
backofficeRoutes.post('/admin/alerts/:kind/:id/acknowledge', async (req, res) => {
  res.json(
    await acknowledgeAlert(
      actor(req, 'ADMIN'),
      String(req.params.kind),
      String(req.params.id),
      req.requestId,
    ),
  );
});

backofficeRoutes.get('/admin/orders', async (req, res) => {
  actor(req, 'ADMIN');
  res.json(await monitoringPage('orders', req.query));
});
backofficeRoutes.get('/admin/deliveries', async (req, res) => {
  actor(req, 'ADMIN');
  res.json(await monitoringPage('deliveries', req.query));
});
backofficeRoutes.get('/admin/assignments', async (req, res) => {
  actor(req, 'ADMIN');
  res.json(await monitoringPage('assignments', req.query));
});

backofficeRoutes.get('/restaurants/:id/reports', async (req, res) => {
  res.json(
    await reports.restaurantReport(
      actor(req, 'RESTAURANT', 'ADMIN'),
      String(req.params.id),
      req.query,
    ),
  );
});

backofficeRoutes.get('/admin/reports', async (req, res) => {
  actor(req, 'ADMIN');
  res.json(await reports.adminReport(req.query));
});

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
