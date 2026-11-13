import { Router } from 'express';
import { actor } from '../../shared/http/actor.js';
import * as cart from './application/cart.js';
import { checkout } from './application/checkout.js';
import { cancel, rejectOrder, simulatePayment, transition } from './application/order-lifecycle.js';
import { detail, list, quote } from './application/order-queries.js';
import { createOtpChallenge } from '../delivery/index.js';

export const orderRoutes = Router();

orderRoutes.post('/orders/:id/delivery-proof/otp', async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.json(await createOtpChallenge(actor(req, 'CUSTOMER'), String(req.params.id), req.body));
});

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
  res.json(await quote(customer, req.body.items));
});

orderRoutes.post('/checkout', async (req, res) => {
  const customer = actor(req, 'CUSTOMER');
  res.status(201).json(await checkout(customer, req.body));
});

orderRoutes.get('/orders', async (req, res) => {
  res.json(await list(actor(req)));
});

orderRoutes.get('/orders/:id', async (req, res) => {
  res.json(await detail(actor(req), String(req.params.id)));
});

orderRoutes.post('/orders/:id/transition', async (req, res) => {
  const restaurant = actor(req, 'RESTAURANT');
  res.json(await transition(restaurant, String(req.params.id), req.body));
});

orderRoutes.post('/orders/:id/cancel', async (req, res) => {
  const owner = actor(req, 'CUSTOMER', 'RESTAURANT', 'ADMIN');
  res.json(await cancel(owner, String(req.params.id), req.body));
});

orderRoutes.post('/orders/:id/reject', async (req, res) => {
  res.json(
    await rejectOrder(actor(req, 'RESTAURANT'), String(req.params.id), req.body, req.requestId),
  );
});

orderRoutes.post('/orders/:id/simulate-payment', async (req, res) => {
  const customer = actor(req, 'CUSTOMER');
  res.json(await simulatePayment(customer, String(req.params.id), req.body));
});
