import { Router } from 'express';
import * as catalog from '../services/catalog.service.js';
import { actor } from './middleware/actor.js';

export const catalogRoutes = Router();

catalogRoutes.get('/restaurants', async (req, res) => {
  res.json(await catalog.listRestaurants(req.query));
});

catalogRoutes.get('/restaurants/:id', async (req, res) => {
  res.json(await catalog.getRestaurant(req.user, String(req.params.id)));
});

catalogRoutes.post('/restaurants', async (req, res) => {
  const owner = actor(req, 'RESTAURANT');
  res.status(201).json(await catalog.createRestaurant(owner, req.body));
});

catalogRoutes.patch('/restaurants/:id', async (req, res) => {
  const owner = actor(req, 'RESTAURANT', 'ADMIN');
  res.json(await catalog.updateRestaurant(owner, String(req.params.id), req.body));
});

catalogRoutes.get('/manage/restaurants', async (req, res) => {
  res.json(await catalog.listManaged(actor(req, 'RESTAURANT', 'ADMIN')));
});

catalogRoutes.post('/restaurants/:id/items', async (req, res) => {
  const owner = actor(req, 'RESTAURANT', 'ADMIN');
  res.status(201).json(await catalog.createItem(owner, String(req.params.id), req.body));
});

catalogRoutes.put('/items/:id', async (req, res) => {
  const owner = actor(req, 'RESTAURANT', 'ADMIN');
  res.json(await catalog.updateItem(owner, String(req.params.id), req.body));
});

catalogRoutes.delete('/items/:id', async (req, res) => {
  const owner = actor(req, 'RESTAURANT', 'ADMIN');
  await catalog.archiveItem(owner, String(req.params.id));
  res.json({ ok: true });
});
