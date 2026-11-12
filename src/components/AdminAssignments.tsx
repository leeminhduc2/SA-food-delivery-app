import { useCallback, useEffect, useRef, useState } from 'react';
import { label } from '../api';

type Search = {
  searchId: string;
  deliveryId: string;
  status: string;
  round: number;
  offersCreated: number;
};
export function AdminAssignments() {
  const [items, setItems] = useState<Search[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(false);
  const load = useCallback(async (next?: string) => {
    try {
      const response = await fetch(
        '/api/admin/assignments' + (next ? `?cursor=${encodeURIComponent(next)}` : ''),
        { credentials: 'same-origin', signal: controller.current?.signal },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Could not load assignments.');
      if (alive.current) {
        setItems((old) => (next ? [...old, ...result.items] : result.items));
        setCursor(result.nextCursor);
        setError('');
      }
    } catch (err) {
      if (alive.current && !(err instanceof DOMException && err.name === 'AbortError'))
        setError(err instanceof Error ? err.message : 'Could not load assignments.');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    controller.current = new AbortController();
    void load();
    const poll = window.setInterval(() => void load(), 15000);
    const changed = () => void load();
    window.addEventListener('bep:assignment-changed', changed);
    return () => {
      alive.current = false;
      controller.current?.abort();
      window.clearInterval(poll);
      window.removeEventListener('bep:assignment-changed', changed);
    };
  }, [load]);
  return (
    <section className="panel">
      <h2>Driver assignment searches</h2>
      {loading && <p aria-live="polite">Loading searches…</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <button className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}
      {!loading && !error && !items.length && <p>No assignment searches yet.</p>}
      {items.map((item) => (
        <article className="support-request" key={item.searchId}>
          <strong>Delivery #{item.deliveryId.slice(0, 8)}</strong>
          <p>
            {label(item.status)} · Round {item.round} · {item.offersCreated} offers
          </p>
        </article>
      ))}
      {cursor && (
        <button className="button secondary" onClick={() => void load(cursor)}>
          Load more
        </button>
      )}
    </section>
  );
}
