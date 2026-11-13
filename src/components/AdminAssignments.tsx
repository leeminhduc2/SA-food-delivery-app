import { useCallback, useEffect, useRef, useState } from 'react';
import { label } from '../api';

type Search = {
  searchId: string;
  orderId: string;
  deliveryId: string;
  driverId: string | null;
  status: string;
  generation: number;
  round: number;
  offersCreated: number;
  nextRunAt: string;
  deadlineAt: string;
};
type Attempt = {
  attemptId: string;
  driverId: string;
  round: number;
  outcome: string;
  reason: string | null;
  createdAt: string;
};
type Event = {
  id: string;
  round: number;
  event: string;
  reason: string | null;
  createdAt: string;
  nextRunAt: string | null;
};
type Detail = Search & { attempts: Attempt[]; events: Event[] };
type Alert = {
  kind: string;
  resourceId: string;
  deliveryId: string;
  reason: string | null;
  acknowledgedAt: string | null;
};
type Summary = {
  online: number;
  ready: number;
  busy: number;
  pendingSearches: number;
  pendingPayments: number;
  heartbeatMaxAgeSeconds: number;
};
const blank = { status: '', orderId: '', driverId: '', restaurantId: '' };
async function read(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { credentials: 'same-origin', signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Could not load monitoring data.');
  return data;
}
export function AdminAssignments() {
  const [form, setForm] = useState(blank),
    [filters, setFilters] = useState(blank);
  const [items, setItems] = useState<Search[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null),
    [selected, setSelected] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null),
    [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [detailError, setDetailError] = useState('');
  const [busy, setBusy] = useState('');
  const [detailRetry, setDetailRetry] = useState(0);
  const controller = useRef<AbortController | null>(null),
    sequence = useRef(0);
  const load = useCallback(
    async (next?: string) => {
      const request = ++sequence.current;
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      if (!next) setLoading(true);
      try {
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(filters))
          if (value.trim()) params.set(key, value.trim());
        if (next) params.set('cursor', next);
        const [page, metrics, alertPage] = await Promise.all([
          read('/api/admin/assignments?' + params, abort.signal),
          read('/api/admin/monitoring/summary', abort.signal),
          read('/api/admin/alerts', abort.signal),
        ]);
        if (request !== sequence.current) return;
        setItems((previous) => (next ? [...previous, ...page.items] : page.items));
        setCursor(page.nextCursor);
        setSummary(metrics);
        setAlerts(alertPage.items);
        setError('');
      } catch (err) {
        if (!abort.signal.aborted && request === sequence.current)
          setError(err instanceof Error ? err.message : 'Could not load monitoring data.');
      } finally {
        if (request === sequence.current) setLoading(false);
      }
    },
    [filters],
  );
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    const changed = () => void load();
    window.addEventListener('bep:assignment-changed', changed);
    return () => {
      ++sequence.current;
      controller.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener('bep:assignment-changed', changed);
    };
  }, [load]);
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let abort: AbortController | undefined;
    setDetail(null);
    setDetailError('');
    const refresh = () => {
      abort?.abort();
      const current = new AbortController();
      abort = current;
      void read('/api/admin/assignments/' + encodeURIComponent(selected), current.signal)
        .then((result) => {
          if (!current.signal.aborted) {
            setDetail(result);
            setDetailError('');
          }
        })
        .catch((err) => {
          if (!current.signal.aborted)
            setDetailError(err instanceof Error ? err.message : 'Could not load details.');
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('bep:assignment-changed', refresh);
    return () => {
      abort?.abort();
      window.clearInterval(timer);
      window.removeEventListener('bep:assignment-changed', refresh);
    };
  }, [selected, detailRetry]);
  async function acknowledge(alert: Alert) {
    const key = alert.kind + ':' + alert.resourceId;
    setBusy(key);
    try {
      const response = await fetch(
        '/api/admin/alerts/' +
          encodeURIComponent(alert.kind) +
          '/' +
          encodeURIComponent(alert.resourceId) +
          '/acknowledge',
        { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'Bep' } },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Could not acknowledge alert.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not acknowledge alert.');
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="panel assignment-monitoring">
      <h2>Assignment monitoring</h2>
      {summary && (
        <div className="assignment-metrics" aria-label="Operational counts">
          <p>
            <strong>{summary.online}</strong> online drivers
          </p>
          <p>
            <strong>{summary.ready}</strong> ready drivers
          </p>
          <p>
            <strong>{summary.busy}</strong> busy drivers
          </p>
          <p>
            <strong>{summary.pendingSearches}</strong> pending searches
          </p>
          <p>
            <strong>{summary.pendingPayments}</strong> pending payments
          </p>
          <small>
            Online and ready require a heartbeat within {summary.heartbeatMaxAgeSeconds} seconds.
            Counts may overlap.
          </small>
        </div>
      )}
      <h3>Operational alerts</h3>
      {!loading && !alerts.length && <p>No open alerts.</p>}
      {alerts.map((alert) => (
        <article className="support-request" key={alert.kind + alert.resourceId}>
          <strong>
            {label(alert.kind)} - delivery {alert.deliveryId}
          </strong>
          <p>
            Reason: {alert.reason ? label(alert.reason) : 'Not recorded'};{' '}
            {alert.acknowledgedAt ? 'Acknowledged' : 'Awaiting acknowledgement'}
          </p>
          {!alert.acknowledgedAt && (
            <button
              type="button"
              className="button secondary"
              disabled={!!busy}
              onClick={() => void acknowledge(alert)}
            >
              {busy === alert.kind + ':' + alert.resourceId ? 'Saving...' : 'Acknowledge'}
            </button>
          )}
        </article>
      ))}
      <h3>Search assignments</h3>
      <form
        className="assignment-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setSelected('');
          setFilters({ ...form });
        }}
      >
        <label>
          Status
          <select
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
          >
            <option value="">All statuses</option>
            {['WAITING', 'SEARCHING', 'OFFERED', 'ASSIGNED', 'EXHAUSTED', 'CANCELLED'].map(
              (status) => (
                <option key={status} value={status}>
                  {label(status)}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          Order ID
          <input
            value={form.orderId}
            onChange={(e) => setForm({ ...form, orderId: e.target.value })}
          />
        </label>
        <label>
          Driver ID
          <input
            value={form.driverId}
            onChange={(e) => setForm({ ...form, driverId: e.target.value })}
          />
        </label>
        <label>
          Restaurant ID
          <input
            value={form.restaurantId}
            onChange={(e) => setForm({ ...form, restaurantId: e.target.value })}
          />
        </label>
        <button className="button" type="submit">
          Apply filters
        </button>
      </form>
      {loading && <p aria-live="polite">Loading searches...</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}
      {!loading && !error && !items.length && <p>No assignment searches match these filters.</p>}
      {items.map((item) => (
        <article className="support-request" key={item.searchId}>
          <strong>Order {item.orderId}</strong>
          <p>
            Delivery {item.deliveryId} ? {label(item.status)} ? Generation {item.generation} ? Round{' '}
            {item.round} ? {item.offersCreated} offers
          </p>
          <button type="button" className="text-button" onClick={() => setSelected(item.searchId)}>
            View search details
          </button>
        </article>
      ))}
      {cursor && (
        <button type="button" className="button secondary" onClick={() => void load(cursor)}>
          Load more
        </button>
      )}
      {selected && (
        <section aria-label="Search details">
          <h3>Search details</h3>
          {detailError && (
            <p role="alert">
              {detailError}{' '}
              <button
                type="button"
                className="text-button"
                onClick={() => setDetailRetry((value) => value + 1)}
              >
                Try again
              </button>
            </p>
          )}
          {!detail && !detailError && <p>Loading details...</p>}
          {detail && (
            <>
              <p>
                Generation {detail.generation} ? {label(detail.status)} ? Deadline{' '}
                {new Date(detail.deadlineAt).toLocaleString()} ? Next run{' '}
                {new Date(detail.nextRunAt).toLocaleString()}
              </p>
              <h4>Search timeline</h4>
              {!detail.events.length && (
                <p>No search events recorded. Earlier searches may predate this timeline.</p>
              )}
              {detail.events.map((event) => (
                <p key={event.id}>
                  Round {event.round}: {label(event.event)} -{' '}
                  {event.reason ? label(event.reason) : 'Reason not recorded'} at{' '}
                  {new Date(event.createdAt).toLocaleString()}
                  {event.nextRunAt && ' ? Retry ' + new Date(event.nextRunAt).toLocaleString()}
                </p>
              ))}
              <h4>Driver attempts</h4>
              {!detail.attempts.length && <p>No driver attempts recorded.</p>}
              {detail.attempts.map((attempt) => (
                <p key={attempt.attemptId}>
                  Driver {attempt.driverId} ? Round {attempt.round} ? {label(attempt.outcome)}
                  {attempt.reason && ' ? ' + label(attempt.reason)} ?{' '}
                  {new Date(attempt.createdAt).toLocaleString()}
                </p>
              ))}
            </>
          )}
        </section>
      )}
    </section>
  );
}
