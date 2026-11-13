import { useCallback, useEffect, useRef, useState } from 'react';
import { api, label } from '../api';
import { errorText } from '../types';

function useLoader<T>(path: string) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api(path));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, load };
}

/** Restaurant replies and moderation requests. The customer's review text is read-only. */
export function RestaurantReviews({ restaurants }: { restaurants: any[] }) {
  const [restaurantId, setRestaurantId] = useState(restaurants[0]?.id ?? '');
  if (!restaurants.length) return null;
  return (
    <section className="panel" aria-labelledby="restaurant-reviews-heading">
      <h2 id="restaurant-reviews-heading">Customer reviews</h2>
      {restaurants.length > 1 && (
        <label className="field">
          Restaurant
          <select value={restaurantId} onChange={(e) => setRestaurantId(e.target.value)}>
            {restaurants.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {restaurantId && <ReviewList key={restaurantId} restaurantId={restaurantId} />}
    </section>
  );
}

function ReviewList({ restaurantId }: { restaurantId: string }) {
  const { data, error, loading, load } = useLoader<{ items: any[] }>(
    `/restaurants/${encodeURIComponent(restaurantId)}/reviews/manage`,
  );
  if (loading && !data) return <p className="muted">Loading reviews...</p>;
  if (error)
    return (
      <div role="alert" className="form-error">
        {error}{' '}
        <button type="button" className="text-button" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  if (!data?.items.length) return <p className="muted">No reviews yet.</p>;
  return (
    <div className="review-responses">
      {data.items.map((review) => (
        <ReviewItem key={review.id} review={review} saved={load} />
      ))}
    </div>
  );
}

function ReviewItem({ review, saved }: { review: any; saved: () => Promise<void> }) {
  const [reply, setReply] = useState(review.reply?.content ?? ''),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const keys = useRef<Record<string, string>>({});
  const pending = review.moderationRequests.find((r: any) => r.status === 'PENDING');
  async function submit(kind: string, path: string, method: string, body: object) {
    const signature = `${kind}:${JSON.stringify(body)}`;
    keys.current[signature] ||= crypto.randomUUID();
    setBusy(true);
    setError('');
    try {
      await api(path, method, { ...body, idempotencyKey: keys.current[signature] });
      if (kind === 'moderation') setReason('');
      await saved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="support-request">
      <div className="between">
        <strong>{review.rating}/5</strong>
        <span className="status">{review.hidden ? 'Hidden' : 'Published'}</span>
      </div>
      <p>{review.content}</p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit('reply', `/reviews/${review.id}/reply`, review.reply ? 'PUT' : 'POST', {
            content: reply.trim(),
          });
        }}
      >
        <label className="field">
          {review.reply ? `Edit reply (revision ${review.reply.revision})` : 'Reply to this review'}
          <textarea
            value={reply}
            minLength={3}
            maxLength={1000}
            required
            onChange={(e) => setReply(e.target.value)}
          />
        </label>
        <button className="button secondary small" disabled={busy}>
          {busy ? 'Saving...' : review.reply ? 'Update reply' : 'Post reply'}
        </button>
      </form>
      {pending ? (
        <p className="info">Moderation request pending: {pending.reason}</p>
      ) : (
        !review.hidden && (
          <details>
            <summary>Ask an administrator to review this</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit('moderation', `/reviews/${review.id}/moderation-requests`, 'POST', {
                  reason: reason.trim(),
                });
              }}
            >
              <label className="field">
                Reason and evidence
                <textarea
                  value={reason}
                  minLength={3}
                  maxLength={300}
                  required
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <button className="button secondary small" disabled={busy}>
                Send moderation request
              </button>
            </form>
          </details>
        )
      )}
      {review.moderationRequests
        .filter((r: any) => r.status !== 'PENDING')
        .map((r: any) => (
          <p key={r.id} className="small-text muted">
            Moderation {label(r.status)}: {r.decision_reason}
          </p>
        ))}
    </article>
  );
}

/** Admin queue: each decision needs a reason and keeps the request history. */
export function ModerationRequests({ onDecided }: { onDecided: () => Promise<void> | void }) {
  const { data, error, loading, load } = useLoader<{ items: any[] }>(
    '/admin/review-moderation-requests?status=PENDING',
  );
  const [reasons, setReasons] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(''),
    [failure, setFailure] = useState('');
  const keys = useRef<Record<string, string>>({});
  async function decide(id: string, decision: 'APPROVE' | 'REJECT') {
    const reason = (reasons[id] ?? '').trim();
    const signature = `${id}:${decision}:${reason}`;
    keys.current[signature] ||= crypto.randomUUID();
    setBusy(id);
    setFailure('');
    try {
      await api(`/admin/review-moderation-requests/${id}`, 'PATCH', {
        decision,
        reason,
        idempotencyKey: keys.current[signature],
      });
      await load();
      await onDecided();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="panel" aria-labelledby="moderation-requests-heading">
      <h2 id="moderation-requests-heading">Moderation requests</h2>
      {failure && (
        <p role="alert" className="form-error">
          {failure}
        </p>
      )}
      {loading && !data ? (
        <p className="muted">Loading requests...</p>
      ) : error ? (
        <div role="alert" className="form-error">
          {error}{' '}
          <button type="button" className="text-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : !data?.items.length ? (
        <p className="muted">No pending moderation requests.</p>
      ) : (
        data.items.map((request) => (
          <article className="support-request" key={request.id}>
            <p>
              <strong>{request.review.rating}/5</strong> · {request.review.content}
            </p>
            <p className="small-text">Restaurant reason: {request.reason}</p>
            <label className="field">
              Decision reason
              <input
                value={reasons[request.id] ?? ''}
                minLength={3}
                maxLength={300}
                onChange={(e) => setReasons({ ...reasons, [request.id]: e.target.value })}
              />
            </label>
            <div className="row-actions">
              <button
                className="button small"
                disabled={busy === request.id || (reasons[request.id] ?? '').trim().length < 3}
                onClick={() => void decide(request.id, 'APPROVE')}
              >
                Approve and hide
              </button>
              <button
                className="button secondary small"
                disabled={busy === request.id || (reasons[request.id] ?? '').trim().length < 3}
                onClick={() => void decide(request.id, 'REJECT')}
              >
                Reject
              </button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}
