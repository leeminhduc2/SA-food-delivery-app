import { useEffect, useState } from 'react';
import { api, label } from '../api';
import { errorText } from '../types';

type HistoryItem = {
  assignmentId: string;
  restaurantName: string;
  assignedAt: string;
  endedAt: string | null;
  result: string;
  finalDriver: boolean;
};
export function DriverHistory() {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    api('/driver/deliveries/history')
      .then((result) => {
        if (live) {
          setItems(result.items);
          setCursor(result.nextCursor);
          setError('');
        }
      })
      .catch((err) => {
        if (live) setError(errorText(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [attempt]);
  async function more() {
    if (!cursor) return;
    setLoading(true);
    try {
      const result = await api('/driver/deliveries/history?cursor=' + encodeURIComponent(cursor));
      setItems((old) => [...old, ...result.items]);
      setCursor(result.nextCursor);
      setError('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }
  return (
    <section className="panel">
      <h2>Assignment history</h2>
      {error && (
        <p role="alert">
          {error}{' '}
          <button className="text-button" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        </p>
      )}
      {loading && <p aria-live="polite">Loading history…</p>}
      {!loading && !error && items.length === 0 && <p>No assignments yet.</p>}
      {items.map((item) => (
        <article key={item.assignmentId}>
          <strong>{item.restaurantName}</strong>
          <p>
            {label(item.result)} · {new Date(item.assignedAt).toLocaleString()}
            {item.finalDriver ? ' · Final driver' : ''}
          </p>
        </article>
      ))}
      {cursor && (
        <button className="button secondary" disabled={loading} onClick={more}>
          Load more
        </button>
      )}
    </section>
  );
}
