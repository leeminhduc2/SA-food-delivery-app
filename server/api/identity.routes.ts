import { Router, type Response } from 'express';
import * as identity from '../services/identity.service.js';
import { actor, tokenFrom } from './middleware/actor.js';

export const identityRoutes = Router();

function setSessionCookie(res: Response, token: string): void {
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 604800000,
    path: '/',
  });
}

identityRoutes.post('/register', async (req, res) => {
  const result = await identity.register(req.body);
  if ('pendingApproval' in result) {
    res.status(201).json({ pendingApproval: true });
    return;
  }
  setSessionCookie(res, result.token);
  res.status(201).json(result.user);
});

identityRoutes.post('/login', async (req, res) => {
  const result = await identity.login(req.body);
  setSessionCookie(res, result.token);
  res.json(result.user);
});

identityRoutes.post('/logout', async (req, res) => {
  await identity.logout(tokenFrom(req.headers.cookie));
  res.clearCookie('session', { path: '/' }).json({ ok: true });
});

identityRoutes.get('/me', (req, res) => res.json(req.user || null));

identityRoutes.patch('/me', async (req, res) => {
  res.json(await identity.updateName(actor(req), req.body));
});
