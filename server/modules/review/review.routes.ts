import { Router } from 'express';
import { actor } from '../../shared/http/actor.js';
import * as reviews from './review.service.js';

export const reviewRoutes = Router();

reviewRoutes.post('/orders/:id/review', async (req, res) => {
  const customer = actor(req, 'CUSTOMER');
  res.status(201).json(await reviews.create(customer, String(req.params.id), req.body));
});

reviewRoutes.patch('/admin/reviews/:id', async (req, res) => {
  const administrator = actor(req, 'ADMIN');
  await reviews.moderate(administrator, String(req.params.id), req.body);
  res.json({ ok: true });
});
