import {
  createHash,
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { id, prisma, transaction } from '../../../shared/db.js';
import { AppError, check } from '../../../shared/errors.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import { deliveryConfig } from '../config.js';
import { orderGateway } from '../delivery.ports.js';
import * as deliveries from '../infrastructure/delivery.repository.js';

const scrypt = promisify(scryptCallback);
const keySchema = z.string().min(8).max(120);
const createSchema = z.object({ idempotencyKey: keySchema }).strict();
const verifySchema = z
  .object({
    challengeId: z.string().min(1).max(128),
    otp: z.string().regex(/^\d{6}$/),
    idempotencyKey: keySchema,
  })
  .strict();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const proofStatus = ['PICKED_UP', 'IN_TRANSIT'];
type Challenge = {
  id: string;
  delivery_id: string;
  assignment_id: string;
  salt: string;
  otp_hash: string;
  status: string;
  attempts: number;
  expires_at: Date;
};

/** Only the customer receives the plaintext, and only on the creation response. */
export async function createOtpChallenge(actor: User, orderId: string, raw: unknown) {
  check(actor.role === 'CUSTOMER', 403, 'FORBIDDEN', 'Customer access required.');
  const input = createSchema.parse(raw),
    keyHash = digest(input.idempotencyKey);
  return transaction(async (db) => {
    const order = await orderGateway().lockOrder(db, orderId);
    check(order, 404, 'NOT_FOUND', 'Order not found.');
    check(order.customerId === actor.id, 403, 'FORBIDDEN', 'You cannot access this order.');
    const delivery = await deliveries.findByOrderForUpdate(orderId, db);
    check(delivery, 404, 'NOT_FOUND', 'Delivery not found.');
    check(
      proofStatus.includes(delivery.status),
      409,
      'PROOF_NOT_AVAILABLE',
      'Proof is available during delivery.',
    );
    check(delivery.driver_id, 409, 'NO_DRIVER', 'Delivery has no assigned driver.');
    const assignment = await deliveries.findActiveAssignment(delivery.id, delivery.driver_id, db);
    check(assignment, 409, 'NO_DRIVER', 'Delivery has no current assignment.');
    const old = await db.$queryRaw<Array<{ id: string; assignment_id: string; expires_at: Date }>>`
      SELECT id,assignment_id,expires_at FROM delivery_otp_challenges WHERE order_id=${orderId} AND customer_id=${actor.id} AND key_hash=${keyHash}`;
    if (old.length) {
      check(
        old[0].assignment_id === assignment.id,
        409,
        'ASSIGNMENT_CHANGED',
        'The assignment changed; request a new code.',
      );
      return { challengeId: old[0].id, otp: null, expiresAt: old[0].expires_at };
    }
    const verified = await db.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM delivery_proofs WHERE delivery_id=${delivery.id} AND assignment_id=${assignment.id} AND status='VERIFIED' LIMIT 1`;
    check(!verified.length, 409, 'PROOF_ALREADY_VERIFIED', 'Delivery proof is already verified.');
    const [{ count }] = await db.$queryRaw<
      Array<{ count: number }>
    >`SELECT count(*)::int AS count FROM delivery_otp_challenges WHERE order_id=${orderId} AND customer_id=${actor.id} AND created_at > clock_timestamp() - interval '10 minutes'`;
    check(count < 3, 429, 'OTP_RATE_LIMIT', 'Too many codes requested. Try again later.');
    const otp = randomInt(0, 1000000).toString().padStart(6, '0');
    const salt = randomBytes(16).toString('hex');
    const hash = ((await scrypt(otp, salt, 64)) as Buffer).toString('hex');
    await db.$executeRaw`UPDATE delivery_otp_challenges SET status='REVOKED' WHERE delivery_id=${delivery.id} AND status='ACTIVE'`;
    const challengeId = id();
    const rows = await db.$queryRaw<Array<{ expires_at: Date }>>`
      INSERT INTO delivery_otp_challenges (id,order_id,delivery_id,assignment_id,customer_id,salt,otp_hash,expires_at,key_hash)
      VALUES (${challengeId},${orderId},${delivery.id},${assignment.id},${actor.id},${salt},${hash},clock_timestamp()+${deliveryConfig.DELIVERY_OTP_TTL_SECONDS} * interval '1 second',${keyHash}) RETURNING expires_at`;
    await audits.audit(actor.id, 'DELIVERY_OTP_CREATED', delivery.id, { challengeId }, db, {
      resourceType: 'DELIVERY',
      outcome: 'SUCCESS',
    });
    return { challengeId, otp, expiresAt: rows[0].expires_at };
  });
}

/** Errors that increment an attempt are returned after commit so they cannot roll back the count. */
export async function verifyOtpProof(actor: User, deliveryId: string, raw: unknown) {
  check(actor.role === 'DRIVER', 403, 'FORBIDDEN', 'Driver access required.');
  const input = verifySchema.parse(raw),
    keyHash = digest(input.idempotencyKey);
  const found = await deliveries.findById(deliveryId);
  check(found, 404, 'NOT_FOUND', 'Delivery not found.');
  const result = await transaction(async (db) => {
    const order = await orderGateway().lockOrder(db, found.order_id);
    const delivery = await deliveries.findForUpdate(deliveryId, db);
    check(order && delivery, 404, 'NOT_FOUND', 'Delivery not found.');
    check(
      proofStatus.includes(delivery.status),
      409,
      'PROOF_NOT_AVAILABLE',
      'Proof is available during delivery.',
    );
    check(
      delivery.driver_id === actor.id,
      403,
      'FORBIDDEN',
      'This delivery is not assigned to you.',
    );
    const assignment = await deliveries.findActiveAssignment(delivery.id, actor.id, db);
    check(assignment, 403, 'FORBIDDEN', 'This delivery is not assigned to you.');
    const challenges = await db.$queryRaw<
      Challenge[]
    >`SELECT id,delivery_id,assignment_id,salt,otp_hash,status,attempts,expires_at FROM delivery_otp_challenges WHERE id=${input.challengeId} AND delivery_id=${deliveryId} FOR UPDATE`;
    const challenge = challenges[0];
    check(challenge, 404, 'NOT_FOUND', 'Challenge not found.');
    check(
      challenge.assignment_id === assignment.id,
      409,
      'ASSIGNMENT_CHANGED',
      'This code belongs to an earlier assignment.',
    );
    const receipts = await db.$queryRaw<
      Array<{ challenge_id: string; outcome: string; proof_id: string | null }>
    >`
      SELECT challenge_id,outcome,proof_id FROM delivery_otp_attempts WHERE delivery_id=${deliveryId} AND driver_id=${actor.id} AND key_hash=${keyHash}`;
    if (receipts.length) {
      const receipt = receipts[0];
      check(
        receipt.challenge_id === challenge.id,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This key was used for another challenge.',
      );
      if (receipt.outcome === 'VERIFIED')
        return { proofId: receipt.proof_id!, method: 'OTP' as const, status: 'VERIFIED' as const };
      return { error: receipt.outcome === 'LOCKED' ? 'OTP_LOCKED' : 'OTP_INVALID' };
    }
    if (challenge.status !== 'ACTIVE')
      return {
        error:
          challenge.status === 'LOCKED'
            ? 'OTP_LOCKED'
            : challenge.status === 'EXPIRED'
              ? 'OTP_EXPIRED'
              : 'OTP_REVOKED',
      };
    const [{ now }] = await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (challenge.expires_at <= now) {
      await db.$executeRaw`UPDATE delivery_otp_challenges SET status='EXPIRED' WHERE id=${challenge.id}`;
      return { error: 'OTP_EXPIRED' };
    }
    const actual = (await scrypt(input.otp, challenge.salt, 64)) as Buffer;
    const expected = Buffer.from(challenge.otp_hash, 'hex');
    const valid = expected.length === actual.length && timingSafeEqual(expected, actual);
    const attemptId = id();
    if (!valid) {
      const attempts = challenge.attempts + 1;
      const outcome = attempts >= deliveryConfig.DELIVERY_OTP_MAX_ATTEMPTS ? 'LOCKED' : 'INVALID';
      await db.$executeRaw`UPDATE delivery_otp_challenges SET attempts=${attempts},status=${outcome === 'LOCKED' ? 'LOCKED' : 'ACTIVE'} WHERE id=${challenge.id}`;
      await db.$executeRaw`INSERT INTO delivery_otp_attempts (id,delivery_id,challenge_id,driver_id,key_hash,outcome) VALUES (${attemptId},${deliveryId},${challenge.id},${actor.id},${keyHash},${outcome})`;
      await audits.audit(
        actor.id,
        'DELIVERY_OTP_ATTEMPT',
        deliveryId,
        { challengeId: challenge.id, outcome },
        db,
        { resourceType: 'DELIVERY', outcome: 'FAILURE' },
      );
      return { error: outcome === 'LOCKED' ? 'OTP_LOCKED' : 'OTP_INVALID' };
    }
    const proofId = id();
    await db.$executeRaw`INSERT INTO delivery_proofs (id,delivery_id,assignment_id,challenge_id,method,status) VALUES (${proofId},${deliveryId},${assignment.id},${challenge.id},'OTP','VERIFIED')`;
    await db.$executeRaw`UPDATE delivery_otp_challenges SET status='VERIFIED' WHERE id=${challenge.id}`;
    await db.$executeRaw`INSERT INTO delivery_otp_attempts (id,delivery_id,challenge_id,driver_id,key_hash,outcome,proof_id) VALUES (${attemptId},${deliveryId},${challenge.id},${actor.id},${keyHash},'VERIFIED',${proofId})`;
    await audits.audit(
      actor.id,
      'DELIVERY_OTP_VERIFIED',
      deliveryId,
      { challengeId: challenge.id, proofId },
      db,
      { resourceType: 'DELIVERY', outcome: 'SUCCESS' },
    );
    return { proofId, method: 'OTP' as const, status: 'VERIFIED' as const };
  });
  if ('error' in result && result.error) {
    const code = result.error;
    throw new AppError(
      code === 'OTP_INVALID' ? 400 : 409,
      code,
      code === 'OTP_INVALID'
        ? 'Invalid delivery code.'
        : code === 'OTP_LOCKED'
          ? 'This code is locked. Ask the customer for a new code.'
          : code === 'OTP_EXPIRED'
            ? 'This code has expired.'
            : 'This code is no longer active.',
    );
  }
  return result;
}
