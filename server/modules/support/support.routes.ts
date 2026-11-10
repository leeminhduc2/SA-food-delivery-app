import { Router } from 'express';
import { actor } from '../../shared/http/actor.js';
import * as support from './support.service.js';

export const supportRoutes = Router();

supportRoutes.post('/orders/:id/complaints', async (req, res) => {
  const customer = actor(req, 'CUSTOMER');
  res.status(201).json(await support.createComplaint(customer, String(req.params.id), req.body));
});

supportRoutes.get('/complaints', async (req, res) => {
  res.json(await support.list(actor(req, 'CUSTOMER', 'ADMIN')));
});

supportRoutes.post('/admin/complaints/:id/resolve', async (req, res) => {
  const administrator = actor(req, 'ADMIN');
  await support.resolve(administrator, String(req.params.id), req.body);
  res.json({ ok: true });
});
