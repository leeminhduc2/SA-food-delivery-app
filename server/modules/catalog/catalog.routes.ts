import { Router } from 'express';
import * as catalog from './application/catalog.service.js';
import { actor } from '../../shared/http/actor.js';
import * as groups from './application/menu-groups.service.js';
import { adjustStock, setStockThreshold } from './application/inventory.service.js';
import { stockHistory } from './application/inventory-history.service.js';

export const catalogRoutes = Router();

catalogRoutes.get('/restaurants/:id/menus', async (req, res) => {
  res.json(await groups.listGroups(actor(req, 'RESTAURANT', 'ADMIN'), String(req.params.id)));
});
catalogRoutes.post('/restaurants/:id/menus', async (req, res) => {
  res
    .status(201)
    .json(await groups.createGroup(actor(req, 'RESTAURANT'), String(req.params.id), req.body));
});
catalogRoutes.patch('/menus/:id', async (req, res) => {
  res.json(await groups.renameGroup(actor(req, 'RESTAURANT'), String(req.params.id), req.body));
});
catalogRoutes.delete('/menus/:id', async (req, res) => {
  await groups.deleteGroup(actor(req, 'RESTAURANT'), String(req.params.id));
  res.json({ ok: true });
});

catalogRoutes.get('/restaurants', async (req, res) => {
  res.json(await catalog.listRestaurants(req.query, req.user));
});

catalogRoutes.get('/restaurants/nearby', async (req, res) => {
  res.json(await catalog.listRestaurants({ ...req.query, sort: 'recommended' }, req.user));
});

catalogRoutes.get('/restaurants/:id/shipping-quote', async (req, res) => {
  res.json(await catalog.shippingQuoteForRestaurant(actor(req), String(req.params.id)));
});

catalogRoutes.get('/restaurants/:id', async (req, res) => {
  res.json(await catalog.getRestaurant(req.user, String(req.params.id)));
});

catalogRoutes.post('/restaurants', async (req, res) => {
  const owner = actor(req, 'RESTAURANT');
  res.status(201).json(await catalog.createRestaurant(owner, req.body));
});

catalogRoutes.patch('/restaurants/:id', async (req, res) => {
  const owner = actor(req, 'RESTAURANT');
  res.json(await catalog.updateRestaurant(owner, String(req.params.id), req.body));
});

catalogRoutes.delete('/restaurants/:id', async (req, res) => {
  const owner = actor(req, 'RESTAURANT');
  await catalog.archiveRestaurant(owner, String(req.params.id));
  res.json({ ok: true });
});

catalogRoutes.get('/restaurants/:id/items', async (req, res) => {
  res.json(await catalog.listPublicItems(req.user, String(req.params.id)));
});

catalogRoutes.get('/manage/restaurants', async (req, res) => {
  res.json(await catalog.listManaged(actor(req, 'RESTAURANT', 'ADMIN')));
});

catalogRoutes.post('/restaurants/:id/items', async (req, res) => {
  const owner = actor(req, 'RESTAURANT');
  res.status(201).json(await catalog.createItem(owner, String(req.params.id), req.body));
});

catalogRoutes.get('/items/:id', async (req, res) => {
  res.json(await catalog.getItem(req.user, String(req.params.id)));
});

catalogRoutes.post('/items/:id/stock-adjustments', async (req, res) => {
  res.json(await adjustStock(actor(req, 'RESTAURANT'), String(req.params.id), req.body));
});
catalogRoutes.get('/items/:id/stock-movements', async (req, res) => {
  res.json(await stockHistory(actor(req, 'RESTAURANT', 'ADMIN'), String(req.params.id), req.query));
});
catalogRoutes.patch('/items/:id/stock-threshold', async (req, res) => {
  res.json(await setStockThreshold(actor(req, 'RESTAURANT'), String(req.params.id), req.body));
});

catalogRoutes.put('/items/:id', async (req, res) => {
  const owner = actor(req, 'RESTAURANT');
  res.json(await catalog.updateItem(owner, String(req.params.id), req.body));
});

catalogRoutes.patch('/items/:id', async (req, res) => {
  const owner = actor(req, 'RESTAURANT');
  res.json(await catalog.updateItem(owner, String(req.params.id), req.body));
});

catalogRoutes.delete('/items/:id', async (req, res) => {
  const owner = actor(req, 'RESTAURANT');
  await catalog.archiveItem(owner, String(req.params.id));
  res.json({ ok: true });
});

catalogRoutes.post('/admin/restaurants/:id/approval', async (req, res) => {
  const administrator = actor(req, 'ADMIN');
  await catalog.setApproval(administrator, String(req.params.id), req.body, req.requestId);
  res.json({ ok: true });
});

catalogRoutes.post('/admin/restaurants/:id/suspend', async (req, res) => {
  const administrator = actor(req, 'ADMIN');
  await catalog.suspendRestaurant(administrator, String(req.params.id), req.body, req.requestId);
  res.json({ ok: true });
});
