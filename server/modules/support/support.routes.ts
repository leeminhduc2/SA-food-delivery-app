import { Router } from 'express';
import { actor } from '../../shared/http/actor.js';
import * as support from './support.service.js';

export const supportRoutes = Router();

supportRoutes.post('/orders/:id/complaints', async (req, res) => {
  const reporter = actor(req, 'CUSTOMER', 'RESTAURANT', 'DRIVER');
  res.status(201).json(await support.createComplaint(reporter, String(req.params.id), req.body));
});

supportRoutes.get('/complaints', async (req, res) => {
  res.json(await support.list(actor(req)));
});

supportRoutes.get('/complaints/:id', async (req, res) => {
  res.json(await support.detail(actor(req), String(req.params.id)));
});

supportRoutes.post('/admin/complaints/:id/resolve', async (req, res) => {
  const administrator = actor(req, 'ADMIN');
  await support.resolve(administrator, String(req.params.id), req.body);
  res.json({ ok: true });
});
