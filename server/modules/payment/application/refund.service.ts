import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma, transaction, type DB } from '../../../shared/db.js';
import { AppError, check } from '../../../shared/errors.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import { activeAdministratorIds } from '../../identity/index.js';
import { notifyOnce } from '../../notification/index.js';
import { paymentConfig, refundBackoffSeconds } from '../config.js';
import * as payments from '../infrastructure/payment.repository.js';
import * as refunds from '../infrastructure/refund.repository.js';
import { paymentAdapter, providerCall, providerRead } from '../infrastructure/payment-provider.js';
import { orderGateway, refundContextGateway } from '../payment.ports.js';

const key = z.string().min(8).max(120);
const reason = z.string().trim().min(3).max(300);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const LEASE_SECONDS = 30;

export function toDto(row: refunds.RefundRow & { history?: any[] }, viewer: User) {
  return {
    id: row.id,
    orderId: row.order_id,
    source: row.source,
    incidentId: row.incident_id,
    complaintId: row.complaint_id,
    reason: row.reason,
    amount: row.amount,
    status: row.status,
    decisionReason: row.decision_reason,
    decidedAt: row.decided_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    ...(viewer.role === 'ADMIN'
      ? {
          paymentId: row.payment_id,
          requestedBy: row.requested_by,
          requesterRole: row.requester_role,
          lastError: row.last_error,
          history: row.history?.map((entry) => ({
            from: entry.from_status,
            to: entry.to_status,
            actor: entry.actor,
            reason: entry.reason,
            createdAt: entry.created_at,
          })),
        }
      : {}),
  };
}

/** Locks Order then Payment, matching cancellation and webhook lock order. */
async function lockOrderPayment(db: DB, orderId: string) {
  await orderGateway().lockOrder(db, orderId);
  const payment = await payments.findByOrderForUpdate(orderId, db);
  check(payment, 404, 'NOT_FOUND', 'Payment not found.');
  return payment;
}

/**
 * Full refund request for a collected payment. DELIVERY_FAILED needs a failure
 * incident and DELIVERED a complaint on the same order; other states use the
 * existing automatic cancellation refund. The amount is always Payment.amount.
 */
export async function requestRefund(actor: User, orderId: string, raw: unknown) {
  check(
    ['CUSTOMER', 'ADMIN'].includes(actor.role),
    403,
    'FORBIDDEN',
    'Only the customer or an administrator can request a refund.',
  );
  const input = z
    .object({
      complaintId: z.string().min(1).max(128).optional(),
      incidentId: z.string().min(1).max(128).optional(),
      reason,
      idempotencyKey: key,
    })
    .strict()
    .parse(raw);
  const context = refundContextGateway();
  const order = await context.orderForRefund(actor, orderId);
  let source: 'INCIDENT' | 'COMPLAINT';
  let incidentId: string | null = null,
    complaintId: string | null = null;
  if (order.status === 'DELIVERY_FAILED') {
    const incident = await context.failureIncident(orderId, input.incidentId);
    check(
      incident,
      409,
      'INCIDENT_REQUIRED',
      'A failed-delivery incident is required for this refund.',
    );
    source = 'INCIDENT';
    incidentId = incident.id;
  } else if (order.status === 'DELIVERED') {
    const complaint = input.complaintId
      ? await context.complaint(orderId, input.complaintId)
      : undefined;
    check(
      complaint,
      409,
      'COMPLAINT_REQUIRED',
      'Open a support request for this order before asking for a refund.',
    );
    source = 'COMPLAINT';
    complaintId = complaint.id;
  } else
    throw new AppError(
      409,
      'REFUND_NOT_ELIGIBLE',
      'Refunds can be requested for delivered or failed deliveries. Cancelled orders are refunded automatically.',
    );
  const keyHash = digest(input.idempotencyKey);
  const fingerprint = JSON.stringify([source, incidentId, complaintId, input.reason]);
  return transaction(async (db) => {
    const payment = await lockOrderPayment(db, orderId);
    const receipt = await refunds.findReceipt(actor.id, orderId, keyHash, db);
    if (receipt) {
      check(
        JSON.stringify([
          receipt.source,
          receipt.incident_id,
          receipt.complaint_id,
          receipt.reason,
        ]) === fingerprint,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This key was used for a different refund request.',
      );
      return toDto(receipt, actor);
    }
    check(
      !(await refunds.findEffective(payment.id, db)),
      409,
      'REFUND_ALREADY_REQUESTED',
      'A refund for this payment is already requested or completed.',
    );
    check(
      payment.status === 'SUCCEEDED',
      409,
      'PAYMENT_NOT_REFUNDABLE',
      'Only a collected payment can be refunded.',
    );
    const requestId = await refunds.insert(
      {
        orderId,
        paymentId: payment.id,
        customerId: order.customerId,
        source,
        incidentId,
        complaintId,
        requestedBy: actor.id,
        requesterRole: actor.role,
        reason: input.reason,
        amount: payment.amount,
        status: 'REQUESTED',
        keyHash,
      },
      db,
    );
    check(requestId, 409, 'REFUND_ALREADY_REQUESTED', 'A refund is already requested.');
    await audits.audit(actor.id, 'REFUND_REQUESTED', requestId, { orderId, source }, db, {
      resourceType: 'REFUND_REQUEST',
      outcome: 'SUCCESS',
    });
    for (const adminId of await activeAdministratorIds(db))
      await notifyOnce(
        db,
        adminId,
        'REFUND_REQUESTED',
        { orderId, refundRequestId: requestId },
        requestId,
      );
    return toDto((await refunds.findById(requestId, db))!, actor);
  });
}

/**
 * Admin decision. Approval moves the payment to REFUND_PENDING with the stable
 * payment reference in the same transaction; the provider is called later by
 * the worker, outside any lock.
 */
export async function decideRefund(actor: User, requestId: string, raw: unknown) {
  check(actor.role === 'ADMIN', 403, 'FORBIDDEN', 'Administrator access required.');
  const input = z
    .object({ decision: z.enum(['APPROVE', 'REJECT']), reason, idempotencyKey: key })
    .parse(raw);
  const keyHash = digest(input.idempotencyKey);
  const fingerprint = `${input.decision}:${input.reason}`;
  const found = await refunds.findById(requestId);
  check(found, 404, 'NOT_FOUND', 'Refund request not found.');
  return transaction(async (db) => {
    const payment = await lockOrderPayment(db, found.order_id);
    const request = (await refunds.findForUpdate(requestId, db))!;
    const receipt = await audits.findCommandReceipt(
      actor.id,
      'REFUND_DECISION',
      requestId,
      keyHash,
      db,
    );
    if (receipt) {
      check(
        receipt.fingerprint === fingerprint,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This key was used for a different decision.',
      );
      return toDto(request, actor);
    }
    check(
      request.status === 'REQUESTED',
      409,
      'REFUND_ALREADY_DECIDED',
      'This refund request was already decided.',
    );
    const status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    if (status === 'APPROVED') {
      check(
        payment.id === request.payment_id &&
          payment.status === 'SUCCEEDED' &&
          payment.amount === request.amount,
        409,
        'PAYMENT_NOT_REFUNDABLE',
        'The payment is no longer refundable.',
      );
      await payments.setStatus(payment.id, 'REFUND_PENDING', db);
      await audits.history(
        request.order_id,
        'PAYMENT',
        'SUCCEEDED',
        'REFUND_PENDING',
        actor.id,
        input.reason,
        db,
      );
    }
    await refunds.update(
      requestId,
      {
        status,
        decided_by: actor.id,
        decision_reason: input.reason,
        decided_at: new Date(),
      },
      db,
    );
    if (status === 'APPROVED') await refunds.makeDueNow(requestId, db);
    await refunds.addHistory(requestId, 'REQUESTED', status, actor.id, input.reason, db);
    await audits.audit(
      actor.id,
      'REFUND_DECISION',
      requestId,
      { keyHash, fingerprint, status },
      db,
      { resourceType: 'REFUND_REQUEST', outcome: 'SUCCESS' },
    );
    if (request.customer_id)
      await notifyOnce(
        db,
        request.customer_id,
        status === 'APPROVED' ? 'REFUND_APPROVED' : 'REFUND_REJECTED',
        { orderId: request.order_id, refundRequestId: requestId },
        `${requestId}:${status}`,
      );
    return toDto((await refunds.findById(requestId, db))!, actor);
  });
}

/** FAILED requests return to the queue only through an Admin decision with a reason. */
export async function retryRefund(actor: User, requestId: string, raw: unknown) {
  check(actor.role === 'ADMIN', 403, 'FORBIDDEN', 'Administrator access required.');
  const input = z.object({ reason, idempotencyKey: key }).parse(raw);
  const keyHash = digest(input.idempotencyKey);
  const found = await refunds.findById(requestId);
  check(found, 404, 'NOT_FOUND', 'Refund request not found.');
  return transaction(async (db) => {
    await lockOrderPayment(db, found.order_id);
    const request = (await refunds.findForUpdate(requestId, db))!;
    const receipt = await audits.findCommandReceipt(
      actor.id,
      'REFUND_RETRY',
      requestId,
      keyHash,
      db,
    );
    if (receipt) {
      check(
        receipt.fingerprint === input.reason,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This key was used with a different reason.',
      );
      return toDto(request, actor);
    }
    check(
      request.status === 'FAILED',
      409,
      'REFUND_NOT_FAILED',
      'Only failed refunds can be retried.',
    );
    await refunds.update(requestId, { status: 'APPROVED', attempts: 0, lease_until: null }, db);
    await refunds.makeDueNow(requestId, db);
    await refunds.addHistory(requestId, 'FAILED', 'APPROVED', actor.id, input.reason, db);
    await audits.audit(
      actor.id,
      'REFUND_RETRY',
      requestId,
      { keyHash, fingerprint: input.reason },
      db,
      { resourceType: 'REFUND_REQUEST', outcome: 'SUCCESS' },
    );
    return toDto((await refunds.findById(requestId, db))!, actor);
  });
}

/**
 * Called wherever a payment enters REFUND_PENDING without an Admin approval
 * (cancellation, late payment, legacy rows). Inside the caller's transaction;
 * a second call is a no-op because one effective operation exists per payment.
 */
export async function attachRefundOperation(
  db: DB,
  payment: { id: string; order_id: string; amount: number },
  source: 'CANCELLATION' | 'LATE_PAYMENT' | 'LEGACY',
  actorId: string,
): Promise<void> {
  if (await refunds.findEffective(payment.id, db)) return;
  await refunds.insert(
    {
      orderId: payment.order_id,
      paymentId: payment.id,
      customerId: null,
      source,
      requestedBy: actorId,
      requesterRole: 'SYSTEM',
      reason:
        source === 'CANCELLATION'
          ? 'Order cancelled after payment'
          : source === 'LATE_PAYMENT'
            ? 'Payment arrived after the order closed'
            : 'Refund queued before refund requests existed',
      amount: payment.amount,
      status: 'APPROVED',
    },
    db,
  );
}

type Claim = { id: string; order_id: string; payment_id: string; attempts: number; was: string };

/**
 * The single refund executor for every source. Claims due work under a lease,
 * calls the provider outside any transaction, and only a confirmed REFUNDED
 * result moves the payment to REFUNDED. After an attempt whose outcome is
 * unknown it queries by the stable reference before calling refund again.
 */
export async function processRefunds(
  limit = 20,
): Promise<{ confirmed: number; retried: number; failed: number }> {
  const claimed = await refunds.claimDue(limit, LEASE_SECONDS);
  const result = { confirmed: 0, retried: 0, failed: 0 };
  for (const claim of claimed) {
    if (claim.was === 'APPROVED' && claim.attempts === 1)
      await refunds.addHistory(claim.id, 'APPROVED', 'PROCESSING', 'worker', null, prisma);
    const payment = await prisma.payment.findUnique({ where: { id: claim.payment_id } });
    let refunded = false,
      error = 'The provider did not confirm the refund.';
    try {
      if (claim.attempts > 1) {
        const known = await providerRead(() => paymentAdapter.query(payment!.reference));
        refunded = known?.status === 'REFUNDED';
      }
      if (!refunded) {
        const outcome = await providerCall(() => paymentAdapter.refund(payment!.reference));
        refunded = outcome?.status === 'REFUNDED';
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'Provider error';
    }
    if (refunded) {
      if (await confirm(claim)) result.confirmed++;
    } else if (await reschedule(claim, error)) result.failed++;
    else result.retried++;
  }
  return result;
}

async function confirm(claim: Claim): Promise<boolean> {
  return transaction(async (db) => {
    const payment = await lockOrderPayment(db, claim.order_id);
    const request = await refunds.findForUpdate(claim.id, db);
    if (!request || request.status !== 'PROCESSING' || request.attempts !== claim.attempts)
      return false;
    if (payment.status === 'REFUND_PENDING') {
      await payments.setRefunded(payment.id, db);
      await audits.history(
        claim.order_id,
        'PAYMENT',
        'REFUND_PENDING',
        'REFUNDED',
        'worker',
        '',
        db,
      );
    }
    await refunds.update(
      claim.id,
      { status: 'SUCCEEDED', confirmed_at: new Date(), lease_until: null, next_attempt_at: null },
      db,
    );
    await refunds.addHistory(
      claim.id,
      'PROCESSING',
      'SUCCEEDED',
      'worker',
      'Provider confirmed',
      db,
    );
    await audits.audit('worker', 'REFUND_CONFIRMED', claim.id, { orderId: claim.order_id }, db, {
      resourceType: 'REFUND_REQUEST',
      outcome: 'SUCCESS',
    });
    if (request.customer_id)
      await notifyOnce(
        db,
        request.customer_id,
        'REFUND_CONFIRMED',
        { orderId: claim.order_id, refundRequestId: claim.id },
        `${claim.id}:confirmed`,
      );
    return true;
  });
}

/** Returns true when the request reached FAILED and needs an Admin. */
async function reschedule(claim: Claim, error: string): Promise<boolean> {
  return transaction(async (db) => {
    await lockOrderPayment(db, claim.order_id);
    const request = await refunds.findForUpdate(claim.id, db);
    if (!request || request.status !== 'PROCESSING' || request.attempts !== claim.attempts)
      return false;
    const exhausted = claim.attempts >= paymentConfig.REFUND_MAX_ATTEMPTS;
    if (!exhausted) {
      await db.$executeRaw`
        UPDATE refund_requests SET lease_until = NULL, last_error = ${error.slice(0, 300)},
          next_attempt_at = clock_timestamp() + ${refundBackoffSeconds(claim.attempts)} * interval '1 second',
          updated_at = clock_timestamp()
        WHERE id = ${claim.id}`;
      return false;
    }
    await refunds.update(
      claim.id,
      {
        status: 'FAILED',
        lease_until: null,
        next_attempt_at: null,
        last_error: error.slice(0, 300),
      },
      db,
    );
    await refunds.addHistory(claim.id, 'PROCESSING', 'FAILED', 'worker', error.slice(0, 300), db);
    await payments.setReconciliationRequired(claim.payment_id, db);
    await audits.audit('worker', 'REFUND_FAILED', claim.id, { attempts: claim.attempts }, db, {
      resourceType: 'REFUND_REQUEST',
      outcome: 'FAILURE',
    });
    for (const adminId of await activeAdministratorIds(db))
      await notifyOnce(
        db,
        adminId,
        'REFUND_FAILED',
        { orderId: claim.order_id, refundRequestId: claim.id },
        `${claim.id}:failed:${claim.attempts}`,
      );
    return true;
  });
}

export async function listForAdmin(actor: User, query: unknown) {
  const { status, orderId } = z
    .object({
      status: z
        .enum(['REQUESTED', 'APPROVED', 'REJECTED', 'PROCESSING', 'SUCCEEDED', 'FAILED'])
        .optional(),
      orderId: z.string().max(128).optional(),
    })
    .parse(query);
  return { items: (await refunds.list({ status, orderId })).map((row) => toDto(row, actor)) };
}

/** Customer view: requests on one owned order. */
export async function listForOrder(actor: User, orderId: string) {
  await refundContextGateway().orderForRefund(actor, orderId);
  return { items: (await refunds.list({ orderId })).map((row) => toDto(row, actor)) };
}
