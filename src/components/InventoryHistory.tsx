import { useCallback, useEffect, useRef, useState } from 'react';

type Movement = {
  id: string;
  kind: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  createdAt: string;
};
export function InventoryHistory({ itemId, revision }: { itemId: string; revision: number }) {
  const [items, setItems] = useState<Movement[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(
    async (next?: string) => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;
      setLoading(true);
      try {
        const response = await fetch(
          `/api/items/${encodeURIComponent(itemId)}/stock-movements${next ? `?cursor=${encodeURIComponent(next)}` : ''}`,
          { credentials: 'same-origin', signal: current.signal },
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Could not load stock history.');
        if (!current.signal.aborted) {
          setItems((old) => (next ? [...old, ...data.items] : data.items));
          setCursor(data.nextCursor);
          setError('');
        }
      } catch (err) {
        if (!current.signal.aborted)
          setError(err instanceof Error ? err.message : 'Could not load stock history.');
      } finally {
        if (!current.signal.aborted) setLoading(false);
      }
    },
    [itemId],
  );
  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load, revision]);
  return (
    <section aria-label="Stock history">
      <h4>Stock history</h4>
      {loading && <p aria-live="polite">Loading stock history...</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}
      {!loading && !error && !items.length && <p>No stock movements recorded yet.</p>}
      {items.map((entry) => (
        <p key={entry.id}>
          {new Date(entry.createdAt).toLocaleString()} · {entry.kind.toLowerCase()} ·{' '}
          {entry.delta > 0 ? '+' : ''}
          {entry.delta} · balance {entry.balanceAfter} · {entry.reason}
        </p>
      ))}
      {cursor && (
        <button
          type="button"
          className="button secondary"
          disabled={loading}
          onClick={() => void load(cursor)}
        >
          Load more movements
        </button>
      )}
    </section>
  );
}
