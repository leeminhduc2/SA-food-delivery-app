import { Router } from 'express';
import { actor } from '../../shared/http/actor.js';
import * as reviews from './review.service.js';
import * as responses from './application/review-response.service.js';

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

// POST creates the first reply, PUT revises it; both append a revision.
reviewRoutes.post('/reviews/:id/reply', async (req, res) => {
  res.json(await responses.reply(actor(req, 'RESTAURANT'), String(req.params.id), req.body));
});
reviewRoutes.put('/reviews/:id/reply', async (req, res) => {
  res.json(await responses.reply(actor(req, 'RESTAURANT'), String(req.params.id), req.body));
});

reviewRoutes.post('/reviews/:id/moderation-requests', async (req, res) => {
  res
    .status(201)
    .json(
      await responses.requestModeration(actor(req, 'RESTAURANT'), String(req.params.id), req.body),
    );
});

reviewRoutes.get('/restaurants/:id/reviews/manage', async (req, res) => {
  res.json(await responses.restaurantReviews(actor(req, 'RESTAURANT'), String(req.params.id)));
});

reviewRoutes.get('/admin/review-moderation-requests', async (req, res) => {
  actor(req, 'ADMIN');
  res.json(await responses.listModerationRequests(req.query));
});

reviewRoutes.patch('/admin/review-moderation-requests/:id', async (req, res) => {
  res.json(await responses.decideModeration(actor(req, 'ADMIN'), String(req.params.id), req.body));
});
