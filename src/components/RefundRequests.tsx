import { useCallback, useEffect, useRef, useState } from 'react';
import { api, label, money } from '../api';
import { errorText } from '../types';

/** Distinct wording so a queued or failed refund is never read as money returned. */
export const refundStatusText: Record<string, string> = {
  REQUESTED: 'Refund requested · waiting for review',
  APPROVED: 'Refund approved · queued for the payment simulator',
  PROCESSING: 'Refund processing with the payment simulator',
  FAILED: 'Refund attempt failed · not refunded yet, support will retry',
  SUCCEEDED: 'Refund confirmed by the payment simulator',
  REJECTED: 'Refund request declined',
};

export function RefundStatus({ refund }: { refund: any }) {
  return (
    <p className="info">
      <strong>{refundStatusText[refund.status] ?? label(refund.status)}</strong> ·{' '}
      {money(refund.amount)}
      {refund.status === 'REJECTED' && refund.decision_reason && (
        <>
          <br />
          Reason: {refund.decision_reason}
        </>
      )}
    </p>
  );
}

/**
 * Customer request for a full refund. Failed deliveries use the failure
 * incident; delivered orders need one of the customer's support requests.
 */
export function CustomerRefundRequest({
  order,
  complaints,
  onRequested,
}: {
  order: any;
  complaints: any[];
  onRequested: () => Promise<void> | void;
}) {
  const own = complaints.filter((c) => c.order_id === order.id);
  const [reason, setReason] = useState(''),
    [chosen, setComplaintId] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const keys = useRef<Record<string, string>>({});
  const delivered = order.status === 'DELIVERED';
  // Tickets can arrive after mount; fall back to the newest one for this order.
  const complaintId = own.some((c) => c.id === chosen) ? chosen : (own[0]?.id ?? '');
  if (delivered && !own.length)
    return (
      <p className="small-text muted">
        To ask for a refund, first send a support request describing the problem.
      </p>
    );
  return (
    <details>
      <summary>Request a full refund</summary>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const body = {
            reason: reason.trim(),
            ...(delivered ? { complaintId } : {}),
          };
          const signature = JSON.stringify(body);
          keys.current[signature] ||= crypto.randomUUID();
          setBusy(true);
          setError('');
          try {
            await api(`/orders/${order.id}/refund-requests`, 'POST', {
              ...body,
              idempotencyKey: keys.current[signature],
            });
            await onRequested();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="muted">
          A refund returns the full {money(order.payment?.amount ?? order.total)} after an
          administrator approves it. Payments in this demo are simulated.
        </p>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {delivered && (
          <label className="field">
            Related support request
            <select value={complaintId} onChange={(e) => setComplaintId(e.target.value)}>
              {own.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.content.slice(0, 60)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          Why should this order be refunded?
          <input
            value={reason}
            minLength={3}
            maxLength={300}
            required
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <button className="button secondary" disabled={busy}>
          {busy ? 'Sending...' : 'Send refund request'}
        </button>
      </form>
    </details>
  );
}

/** Admin queue: decisions and retries always carry a reason. */
export function AdminRefundRequests({ onChanged }: { onChanged: () => Promise<void> | void }) {
  const [items, setItems] = useState<any[] | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [failure, setFailure] = useState(''),
    [busy, setBusy] = useState(''),
    [reasons, setReasons] = useState<Record<string, string>>({});
  const keys = useRef<Record<string, string>>({});
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems((await api('/admin/refund-requests')).items);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function send(id: string, path: string, body: object) {
    const signature = `${path}:${JSON.stringify(body)}`;
    keys.current[signature] ||= crypto.randomUUID();
    setBusy(id);
    setFailure('');
    try {
      await api(path, 'POST', { ...body, idempotencyKey: keys.current[signature] });
      await load();
      await onChanged();
    } catch (e) {
      setFailure(errorText(e));
    } finally {
      setBusy('');
    }
  }
  const open = (items ?? []).filter((item) =>
    ['REQUESTED', 'FAILED', 'APPROVED', 'PROCESSING'].includes(item.status),
  );
  return (
    <section className="panel" aria-labelledby="refunds-heading">
      <h2 id="refunds-heading">Refund requests</h2>
      <p className="small-text muted">
        Payments are simulated. Only a provider confirmation marks a payment refunded.
      </p>
      {failure && (
        <p role="alert" className="form-error">
          {failure}
        </p>
      )}
      {loading && !items ? (
        <p className="muted">Loading refunds...</p>
      ) : error ? (
        <div role="alert" className="form-error">
          {error}{' '}
          <button type="button" className="text-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : !open.length ? (
        <p className="muted">No refunds waiting for action.</p>
      ) : (
        open.map((item) => {
          const reason = (reasons[item.id] ?? '').trim();
          return (
            <article className="queue-item" key={item.id}>
              <div className="between">
                <strong>
                  Order #{item.orderId.slice(0, 8).toUpperCase()} · {money(item.amount)}
                </strong>
                <span className="status">{label(item.status)}</span>
              </div>
              <p>
                {refundStatusText[item.status]} · Source {label(item.source)}
                {item.complaintId && ` · Ticket ${item.complaintId.slice(0, 8)}`}
                {item.incidentId && ` · Incident ${item.incidentId.slice(0, 8)}`}
              </p>
              <p className="small-text">Customer reason: {item.reason}</p>
              {item.lastError && (
                <p className="small-text">
                  Last provider error after {item.attempts} attempts: {item.lastError}
                </p>
              )}
              {['REQUESTED', 'FAILED'].includes(item.status) && (
                <>
                  <label className="field">
                    Decision reason
                    <input
                      value={reasons[item.id] ?? ''}
                      maxLength={300}
                      onChange={(e) => setReasons({ ...reasons, [item.id]: e.target.value })}
                    />
                  </label>
                  <div className="row-actions">
                    {item.status === 'REQUESTED' ? (
                      <>
                        <button
                          className="button small"
                          disabled={busy === item.id || reason.length < 3}
                          onClick={() =>
                            void send(item.id, `/admin/refund-requests/${item.id}/decision`, {
                              decision: 'APPROVE',
                              reason,
                            })
                          }
                        >
                          Approve full refund
                        </button>
                        <button
                          className="button secondary small"
                          disabled={busy === item.id || reason.length < 3}
                          onClick={() =>
                            void send(item.id, `/admin/refund-requests/${item.id}/decision`, {
                              decision: 'REJECT',
                              reason,
                            })
                          }
                        >
                          Reject
                        </button>
                      </>
                    ) : (
                      <button
                        className="button small"
                        disabled={busy === item.id || reason.length < 3}
                        onClick={() =>
                          void send(item.id, `/admin/refund-requests/${item.id}/retry`, { reason })
                        }
                      >
                        Retry refund
                      </button>
                    )}
                  </div>
                </>
              )}
            </article>
          );
        })
      )}
    </section>
  );
}
