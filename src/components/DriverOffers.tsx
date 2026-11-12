import { useCallback, useEffect, useRef, useState } from 'react';
import { money } from '../api';

type Offer = {
  offerId: string;
  pickup: { name: string; address: string };
  deliveryFee: number;
  expiresAt: string;
};
export function DriverOffers({ onChanged }: { onChanged: () => Promise<void> }) {
  const [items, setItems] = useState<Offer[]>([]);
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const keys = useRef<Record<string, string>>({});
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(false);
  const call = useCallback(async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      signal: controller.current?.signal,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Request failed.');
    return result;
  }, []);
  const refresh = useCallback(async () => {
    try {
      const result = await call('/driver/offers');
      if (alive.current) {
        setItems(result.items);
        setOffset(new Date(result.serverTime).getTime() - Date.now());
        setLoading(false);
      }
    } catch (err) {
      if (alive.current && !(err instanceof DOMException && err.name === 'AbortError')) {
        setError(err instanceof Error ? err.message : 'Could not load offers.');
        setLoading(false);
      }
    }
  }, [call]);
  useEffect(() => {
    alive.current = true;
    controller.current = new AbortController();
    void refresh();
    const poll = window.setInterval(() => void refresh(), 10000);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const onOffer = () => void refresh();
    window.addEventListener('bep:offer-changed', onOffer);
    return () => {
      alive.current = false;
      controller.current?.abort();
      window.clearInterval(poll);
      window.clearInterval(tick);
      window.removeEventListener('bep:offer-changed', onOffer);
    };
  }, [refresh]);
  async function respond(offer: Offer, decision: 'accept' | 'reject') {
    const key = `${offer.offerId}:${decision}`;
    keys.current[key] ||= crypto.randomUUID();
    setPending(key);
    setError('');
    try {
      await call(`/driver/offers/${encodeURIComponent(offer.offerId)}/${decision}`, 'POST', {
        idempotencyKey: keys.current[key],
        ...(decision === 'reject' ? { reason: reasons[offer.offerId] } : {}),
      });
      await Promise.all([refresh(), onChanged()]);
    } catch (err) {
      if (alive.current) {
        setError(err instanceof Error ? err.message : 'Could not respond to the offer.');
        await refresh();
      }
    } finally {
      if (alive.current) setPending('');
    }
  }
  return (
    <section className="panel" aria-labelledby="driver-offers-title">
      <h2 id="driver-offers-title">Delivery offers</h2>
      {error && (
        <p role="alert">
          {error}{' '}
          <button
            className="text-button"
            onClick={() => {
              setError('');
              void refresh();
            }}
          >
            Try again
          </button>
        </p>
      )}
      {loading && <p aria-live="polite">Loading offers…</p>}
      {!loading && !items.length && <p>No current offers.</p>}
      {items.map((offer) => {
        const seconds = Math.max(
          0,
          Math.ceil((new Date(offer.expiresAt).getTime() - now - offset) / 1000),
        );
        return (
          <article className="support-request" key={offer.offerId}>
            <h3>{offer.pickup.name}</h3>
            <p>Pickup: {offer.pickup.address}</p>
            <p>
              Delivery fee: {money(offer.deliveryFee)} ·{' '}
              {seconds
                ? `About ${seconds}s remaining`
                : 'Time estimate expired; server will confirm availability'}
            </p>
            <button
              className="button"
              disabled={Boolean(pending)}
              onClick={() => void respond(offer, 'accept')}
            >
              Accept offer
            </button>
            <label className="field">
              Reason to decline{' '}
              <input
                value={reasons[offer.offerId] || ''}
                maxLength={300}
                onChange={(event) => {
                  setReasons({ ...reasons, [offer.offerId]: event.target.value });
                  delete keys.current[`${offer.offerId}:reject`];
                }}
              />
            </label>
            <button
              className="button secondary"
              disabled={Boolean(pending) || (reasons[offer.offerId] || '').trim().length < 3}
              onClick={() => void respond(offer, 'reject')}
            >
              Decline offer
            </button>
          </article>
        );
      })}
    </section>
  );
}
