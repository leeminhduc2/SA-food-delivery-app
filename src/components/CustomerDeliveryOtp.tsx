import { useEffect, useRef, useState } from 'react';

export function CustomerDeliveryOtp({ orderId }: { orderId: string }) {
  const [code, setCode] = useState<string | null>(null),
    [expiresAt, setExpiresAt] = useState('');
  const [lost, setLost] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID()),
    request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), [orderId]);
  async function generate(fresh: boolean) {
    if (fresh) key.current = crypto.randomUUID();
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setCode(null);
    setLost(false);
    setError('');
    setBusy(true);
    try {
      const response = await fetch(
        `/api/orders/${encodeURIComponent(orderId)}/delivery-proof/otp`,
        {
          method: 'POST',
          credentials: 'same-origin',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
          body: JSON.stringify({ idempotencyKey: key.current }),
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Could not create a delivery code.');
      if (!controller.signal.aborted) {
        setCode(result.otp);
        setLost(result.otp === null);
        setExpiresAt(result.expiresAt);
      }
    } catch (err) {
      if (!controller.signal.aborted)
        setError(err instanceof Error ? err.message : 'Could not create a delivery code.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="delivery-otp" aria-label="Delivery code">
      <h3>Delivery code</h3>
      <p>Share the code only with your assigned driver when your order arrives.</p>
      {code && (
        <p aria-live="polite">
          Your delivery code: <strong>{code}</strong>
          <br />
          Expires {new Date(expiresAt).toLocaleTimeString()}.
        </p>
      )}
      {lost && (
        <p className="info">
          This code was already created and cannot be shown again. Generate a new code to replace
          it.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!code && !lost && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void generate(false)}
        >
          {busy ? 'Creating code...' : error ? 'Retry code request' : 'Generate delivery code'}
        </button>
      )}
      {(code || lost) && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void generate(true)}
        >
          Generate a new code
        </button>
      )}
    </section>
  );
}
