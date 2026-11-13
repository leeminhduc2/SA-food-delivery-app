import { useCallback, useEffect, useRef, useState } from 'react';
import { api, label } from '../api';
import { errorText } from '../types';

const RESOLUTIONS = [
  ['NO_ACTION', 'No action needed'],
  ['NO_REFUND', 'No refund'],
  ['REFUND_REQUESTED', 'Refund to be requested'],
] as const;

/**
 * Admin incident queue. Closing a trip as failed is only offered for an open
 * operational incident after pickup; resolving records a decision and never
 * refunds, restocks or resolves a support ticket by itself.
 */
export function DeliveryIncidents({ onChanged }: { onChanged: () => Promise<void> | void }) {
  const [items, setItems] = useState<any[] | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [failure, setFailure] = useState(''),
    [busy, setBusy] = useState(''),
    [reasons, setReasons] = useState<Record<string, string>>({}),
    [choices, setChoices] = useState<Record<string, string>>({});
  const keys = useRef<Record<string, string>>({});
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setItems((await api('/admin/incidents?status=OPEN&limit=50')).items);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  async function send(incident: any, path: string, body: object) {
    const signature = `${path}:${JSON.stringify(body)}`;
    keys.current[signature] ||= crypto.randomUUID();
    setBusy(incident.id);
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
  return (
    <section className="panel" aria-labelledby="incidents-heading">
      <h2 id="incidents-heading">Delivery incidents</h2>
      <p className="small-text muted">
        Resolving records your decision only. Refunds need a separate approved request; deliveries
        are never re-sent after pickup.
      </p>
      {failure && (
        <p role="alert" className="form-error">
          {failure}
        </p>
      )}
      {loading && !items ? (
        <p className="muted">Loading incidents...</p>
      ) : error ? (
        <div role="alert" className="form-error">
          {error}{' '}
          <button type="button" className="text-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : !items?.length ? (
        <p className="muted">No open incidents.</p>
      ) : (
        items.map((incident) => {
          const reason = (reasons[incident.id] ?? '').trim();
          const canFail =
            incident.type === 'DRIVER_UNAVAILABLE' &&
            ['PICKED_UP', 'IN_TRANSIT'].includes(incident.deliveryStatus);
          return (
            <article className="support-request" key={incident.id}>
              <div className="between">
                <strong>
                  {label(incident.type)} · Order #{incident.orderId.slice(0, 8).toUpperCase()}
                </strong>
                <span className="status">
                  Delivery {label(incident.deliveryStatus ?? 'UNKNOWN')}
                </span>
              </div>
              <p>{incident.reason}</p>
              <label className="field">
                Reason or resolution note
                <input
                  value={reasons[incident.id] ?? ''}
                  maxLength={300}
                  onChange={(e) => setReasons({ ...reasons, [incident.id]: e.target.value })}
                />
              </label>
              <label className="field">
                Resolution
                <select
                  value={choices[incident.id] ?? 'NO_ACTION'}
                  onChange={(e) => setChoices({ ...choices, [incident.id]: e.target.value })}
                >
                  {RESOLUTIONS.map(([value, text]) => (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  ))}
                </select>
              </label>
              <div className="row-actions">
                <button
                  className="button secondary small"
                  disabled={busy === incident.id || reason.length < 3}
                  onClick={() =>
                    void send(incident, `/admin/incidents/${incident.id}/resolve`, {
                      resolution: choices[incident.id] ?? 'NO_ACTION',
                      reason,
                    })
                  }
                >
                  Resolve incident
                </button>
                {canFail && (
                  <button
                    className="button small"
                    disabled={busy === incident.id || reason.length < 3}
                    onClick={() =>
                      void send(incident, `/admin/deliveries/${incident.deliveryId}/fail`, {
                        reason,
                      })
                    }
                  >
                    Close delivery as failed
                  </button>
                )}
              </div>
            </article>
          );
        })
      )}
    </section>
  );
}
