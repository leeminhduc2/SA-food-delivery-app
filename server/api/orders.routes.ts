import { Router } from 'express';
import * as cart from '../services/cart.service.js';
import * as orders from '../services/order.service.js';
import { actor } from './middleware/actor.js';

export const orderRoutes = Router();

orderRoutes.get('/cart', async (req, res) => {
  res.json(await cart.get(actor(req, 'CUSTOMER')));
});

orderRoutes.put('/cart', async (req, res) => {
  res.json(await cart.put(actor(req, 'CUSTOMER'), req.body));
});

orderRoutes.delete('/cart/items/:itemId', async (req, res) => {
  res.json(await cart.removeItem(actor(req, 'CUSTOMER'), String(req.params.itemId)));
});

orderRoutes.post('/checkout/quote', async (req, res) => {
  const customer = actor(req, 'CUSTOMER');
  res.json(await orders.quote(customer, req.body.items));
});

orderRoutes.post('/checkout', async (req, res) => {
  const customer = actor(req, 'CUSTOMER');
  res.status(201).json(await orders.checkout(customer, req.body));
});

orderRoutes.get('/orders', async (req, res) => {
  res.json(await orders.list(actor(req)));
});

orderRoutes.get('/orders/:id', async (req, res) => {
  res.json(await orders.detail(actor(req), String(req.params.id)));
});

orderRoutes.post('/orders/:id/transition', async (req, res) => {
  const restaurant = actor(req, 'RESTAURANT');
  res.json(await orders.transition(restaurant, String(req.params.id), req.body));
});

orderRoutes.post('/orders/:id/cancel', async (req, res) => {
  const owner = actor(req, 'CUSTOMER', 'RESTAURANT', 'ADMIN');
  res.json(await orders.cancel(owner, String(req.params.id), req.body));
});
