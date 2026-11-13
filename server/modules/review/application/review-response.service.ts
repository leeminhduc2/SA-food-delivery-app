import { createHash } from 'node:crypto';
import { z } from 'zod';
import { id, prisma, transaction, uniqueViolation, type DB } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import { assertMember } from '../../catalog/index.js';
import { activeAdministratorIds } from '../../identity/index.js';
import { notifyOnce } from '../../notification/index.js';

const key = z.string().min(8).max(120);
const reason = z.string().trim().min(3).max(300);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function lockReview(db: DB, reviewId: string) {
  const rows = await db.$queryRaw<
    Array<{ id: string; restaurant_id: string; hidden: boolean }>
  >`SELECT id, restaurant_id, hidden FROM reviews WHERE id = ${reviewId} FOR UPDATE`;
  check(rows[0], 404, 'NOT_FOUND', 'Review not found.');
  return rows[0];
}

/**
 * Restaurant members keep one current reply with append-only revisions.
 * The customer's review row is never modified here.
 */
export async function reply(actor: User, reviewId: string, raw: unknown) {
  const input = z
    .object({ content: z.string().trim().min(3).max(1000), idempotencyKey: key })
    .parse(raw);
  const keyHash = digest(input.idempotencyKey);
  const run = () =>
    transaction(async (db) => {
      const review = await lockReview(db, reviewId);
      await assertMember(db, actor, review.restaurant_id);
      const current = await db.reviewReply.findUnique({ where: { review_id: reviewId } });
      if (current) {
        const receipt = await db.reviewReplyRevision.findUnique({
          where: {
            author_id_reply_id_key_hash: {
              author_id: actor.id,
              reply_id: current.id,
              key_hash: keyHash,
            },
          },
        });
        if (receipt) {
          check(
            receipt.content === input.content,
            409,
            'IDEMPOTENCY_CONFLICT',
            'This key was used for a different reply.',
          );
          return { replyId: current.id, revision: receipt.revision, content: receipt.content };
        }
      }
      const replyId = current?.id ?? id();
      const revision = (current?.revision ?? 0) + 1;
      if (current)
        await db.reviewReply.update({
          where: { id: replyId },
          data: { content: input.content, revision, author_id: actor.id, updated_at: new Date() },
        });
      else
        await db.reviewReply.create({
          data: {
            id: replyId,
            review_id: reviewId,
            restaurant_id: review.restaurant_id,
            author_id: actor.id,
            content: input.content,
          },
        });
      await db.reviewReplyRevision.create({
        data: {
          id: id(),
          reply_id: replyId,
          revision,
          author_id: actor.id,
          content: input.content,
          key_hash: keyHash,
        },
      });
      await audits.audit(actor.id, 'REVIEW_REPLIED', reviewId, { replyId, revision }, db, {
        resourceType: 'REVIEW',
        outcome: 'SUCCESS',
      });
      return { replyId, revision, content: input.content };
    });
  try {
    return await run();
  } catch (error) {
    // A concurrent first reply lost the unique race; the retry sees it.
    if (uniqueViolation(error)) return run();
    throw error;
  }
}

export async function requestModeration(actor: User, reviewId: string, raw: unknown) {
  const input = z.object({ reason, idempotencyKey: key }).parse(raw);
  const keyHash = digest(input.idempotencyKey);
  return transaction(async (db) => {
    const review = await lockReview(db, reviewId);
    await assertMember(db, actor, review.restaurant_id);
    const existing = await db.reviewModerationRequest.findUnique({
      where: {
        requester_id_review_id_key_hash: {
          requester_id: actor.id,
          review_id: reviewId,
          key_hash: keyHash,
        },
      },
    });
    if (existing) {
      check(
        existing.reason === input.reason,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This key was used for a different request.',
      );
      return { requestId: existing.id, status: existing.status };
    }
    const pending = await db.reviewModerationRequest.findFirst({
      where: { review_id: reviewId, status: 'PENDING' },
      select: { id: true },
    });
    check(!pending, 409, 'MODERATION_PENDING', 'A moderation request is already pending.');
    const requestId = id();
    await db.reviewModerationRequest.create({
      data: {
        id: requestId,
        review_id: reviewId,
        restaurant_id: review.restaurant_id,
        requester_id: actor.id,
        reason: input.reason,
        key_hash: keyHash,
      },
    });
    await audits.audit(
      actor.id,
      'REVIEW_MODERATION_REQUESTED',
      reviewId,
      { requestId, reason: input.reason },
      db,
      { resourceType: 'REVIEW', outcome: 'SUCCESS' },
    );
    for (const adminId of await activeAdministratorIds(db))
      await notifyOnce(
        db,
        adminId,
        'REVIEW_MODERATION_REQUESTED',
        { reviewId, requestId },
        requestId,
      );
    return { requestId, status: 'PENDING' };
  });
}

/** Approve hides the review; reject leaves it. The request keeps both reasons. */
export async function decideModeration(actor: User, requestId: string, raw: unknown) {
  const input = z
    .object({ decision: z.enum(['APPROVE', 'REJECT']), reason, idempotencyKey: key })
    .parse(raw);
  const keyHash = digest(input.idempotencyKey);
  return transaction(async (db) => {
    const found = await db.reviewModerationRequest.findUnique({ where: { id: requestId } });
    check(found, 404, 'NOT_FOUND', 'Moderation request not found.');
    const review = await lockReview(db, found.review_id);
    const receipt = await audits.findCommandReceipt<{
      fingerprint: string;
      status: string;
    }>(actor.id, 'REVIEW_MODERATION_DECIDED', requestId, keyHash, db);
    const fingerprint = `${input.decision}:${input.reason}`;
    if (receipt) {
      check(
        receipt.fingerprint === fingerprint,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This key was used for a different decision.',
      );
      return { requestId, status: receipt.status };
    }
    const status = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    const updated = await db.reviewModerationRequest.updateMany({
      where: { id: requestId, status: 'PENDING' },
      data: {
        status,
        decided_by: actor.id,
        decision_reason: input.reason,
        decided_at: new Date(),
      },
    });
    check(updated.count === 1, 409, 'ALREADY_DECIDED', 'This request was already decided.');
    if (status === 'APPROVED' && !review.hidden)
      await db.review.update({ where: { id: review.id }, data: { hidden: true } });
    await audits.audit(
      actor.id,
      'REVIEW_MODERATION_DECIDED',
      requestId,
      { keyHash, fingerprint, status, reviewId: review.id, reason: input.reason },
      db,
      { resourceType: 'REVIEW_MODERATION', outcome: 'SUCCESS' },
    );
    return { requestId, status };
  });
}

export async function listModerationRequests(query: unknown) {
  const { status } = z
    .object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() })
    .parse(query);
  const rows = await prisma.reviewModerationRequest.findMany({
    where: status ? { status } : {},
    include: { review: { select: { rating: true, content: true, hidden: true } } },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: 100,
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      reviewId: row.review_id,
      restaurantId: row.restaurant_id,
      reason: row.reason,
      status: row.status,
      decisionReason: row.decision_reason,
      decidedAt: row.decided_at,
      createdAt: row.created_at,
      review: row.review,
    })),
  };
}

/** Restaurant members see their reviews with the current reply and moderation state. */
export async function restaurantReviews(actor: User, restaurantId: string) {
  await assertMember(undefined, actor, restaurantId);
  const rows = await prisma.review.findMany({
    where: { restaurant_id: restaurantId },
    include: {
      reply: { select: { content: true, revision: true, updated_at: true } },
      moderation_requests: {
        select: { id: true, status: true, reason: true, decision_reason: true, created_at: true },
        orderBy: { created_at: 'desc' },
      },
    },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    take: 100,
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      rating: row.rating,
      content: row.content,
      hidden: row.hidden,
      createdAt: row.created_at,
      reply: row.reply,
      moderationRequests: row.moderation_requests,
    })),
  };
}
