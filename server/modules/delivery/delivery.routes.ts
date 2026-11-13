import express, { Router } from 'express';
import * as delivery from './application/delivery.service.js';
import { actor } from '../../shared/http/actor.js';
import { history } from './application/driver-history.service.js';
import { getDriverOverride } from './delivery.ports.js';
import { verifyOtpProof } from './application/delivery-proof.service.js';
import { photoTypes, readPhotoProof, uploadPhotoProof } from './application/photo-proof.service.js';
import { deliveryConfig } from './config.js';
import {
  adminFailDelivery,
  listIncidents,
  resolveIncident,
} from './application/incident.service.js';

export const deliveryRoutes = Router();

deliveryRoutes.post('/deliveries/:id/proofs/otp', async (req, res) => {
  res.json(await verifyOtpProof(actor(req, 'DRIVER'), String(req.params.id), req.body));
});

deliveryRoutes.post(
  '/deliveries/:id/proofs/photo',
  // Reject other roles before reading up to the size cap.
  (req, _res, next) => next(void actor(req, 'DRIVER')),
  express.raw({ type: [...photoTypes], limit: deliveryConfig.DELIVERY_PROOF_MAX_BYTES }),
  async (req, res) => {
    res.status(201).json(
      await uploadPhotoProof(actor(req, 'DRIVER'), String(req.params.id), {
        contentType: req.headers['content-type'],
        idempotencyKey: req.headers['x-idempotency-key'],
        body: req.body,
      }),
    );
  },
);

deliveryRoutes.get('/deliveries/:id/proofs/:proofId/content', async (req, res) => {
  const photo = await readPhotoProof(actor(req), String(req.params.id), String(req.params.proofId));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', photo.contentType);
  res.setHeader('Content-Disposition', 'inline');
  res.send(photo.bytes);
});

deliveryRoutes.post('/admin/deliveries/:id/fail', async (req, res) => {
  res.json(await adminFailDelivery(actor(req, 'ADMIN'), String(req.params.id), req.body));
});

deliveryRoutes.get('/admin/incidents', async (req, res) => {
  actor(req, 'ADMIN');
  res.json(await listIncidents(req.query));
});

deliveryRoutes.post('/admin/incidents/:id/resolve', async (req, res) => {
  res.json(await resolveIncident(actor(req, 'ADMIN'), String(req.params.id), req.body));
});

deliveryRoutes.post('/deliveries/:id/arrive', async (req, res) => {
  res.json(await delivery.arrive(actor(req, 'DRIVER'), String(req.params.id), req.body));
});

deliveryRoutes.get('/driver/deliveries/history', async (req, res) => {
  res.json(await history(actor(req, 'DRIVER').id, req.query));
});

deliveryRoutes.post('/deliveries/:id/assign', async (req, res) => {
  res.json(
    await getDriverOverride()(actor(req, 'ADMIN'), String(req.params.id), req.body, req.requestId),
  );
});

deliveryRoutes.post('/deliveries/:id/transition', async (req, res) => {
  await delivery.transition(actor(req, 'DRIVER'), String(req.params.id), req.body);
  res.json({ ok: true });
});
