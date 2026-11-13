import { useEffect, useRef, useState } from 'react';
import { Field } from './Primitives';

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png'];

type Props = {
  deliveryId: string;
  challenge: { id: string; expires_at: string } | null;
  onChanged: () => Promise<void> | void;
};

/** Driver proof: the customer's code or a door photo. One verified proof is enough. */
export function DriverDeliveryProof({ deliveryId, challenge, onChanged }: Props) {
  const [otp, setOtp] = useState(''),
    [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState<'otp' | 'photo' | null>(null),
    [error, setError] = useState(''),
    [done, setDone] = useState('');
  // The same input retries with the same key; any change gets a new key.
  const otpKeys = useRef<Record<string, string>>({}),
    photoKeys = useRef<Record<string, string>>({}),
    request = useRef<AbortController | null>(null),
    errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => () => request.current?.abort(), [deliveryId]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function send(kind: 'otp' | 'photo', init: RequestInit, path: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(kind);
    setError('');
    try {
      const response = await fetch(`/api/deliveries/${encodeURIComponent(deliveryId)}${path}`, {
        ...init,
        credentials: 'same-origin',
        signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || 'The proof could not be saved.');
      if (controller.signal.aborted) return;
      setOtp('');
      setDone(kind === 'otp' ? 'Delivery code verified.' : 'Delivery photo saved.');
      await onChanged();
    } catch (err) {
      if (!controller.signal.aborted)
        setError(err instanceof Error ? err.message : 'The proof could not be saved.');
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    if (!challenge) return;
    if (!/^\d{6}$/.test(otp)) {
      setError('Enter the 6-digit code from the customer.');
      return;
    }
    const signature = `${challenge.id}:${otp}`;
    otpKeys.current[signature] ||= crypto.randomUUID();
    void send(
      'otp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
        body: JSON.stringify({
          challengeId: challenge.id,
          otp,
          idempotencyKey: otpKeys.current[signature],
        }),
      },
      '/proofs/otp',
    );
  }

  function uploadPhoto(event: React.FormEvent) {
    event.preventDefault();
    if (!file) {
      setError('Choose a JPEG or PNG photo.');
      return;
    }
    if (!TYPES.includes(file.type)) {
      setError('Only JPEG or PNG photos can be uploaded.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('The photo must be 5 MB or smaller.');
      return;
    }
    const signature = `${file.name}:${file.size}:${file.lastModified}`;
    photoKeys.current[signature] ||= crypto.randomUUID();
    void send(
      'photo',
      {
        method: 'POST',
        headers: {
          'Content-Type': file.type,
          'X-Requested-With': 'Bep',
          'X-Idempotency-Key': photoKeys.current[signature],
        },
        body: file,
      },
      '/proofs/photo',
    );
  }

  return (
    <section className="delivery-proof" aria-label="Delivery proof">
      <h3>Delivery proof</h3>
      <p className="muted">
        Enter the customer's delivery code or upload a photo at the door. One is enough.
      </p>
      {done && (
        <p className="info" role="status">
          {done}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </p>
      )}
      {challenge ? (
        <form onSubmit={verifyCode} noValidate>
          <Field
            label="Customer delivery code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={otp}
            onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
            required
          />
          <button className="button secondary" disabled={busy !== null}>
            {busy === 'otp' ? 'Verifying code...' : 'Verify code'}
          </button>
        </form>
      ) : (
        <p className="muted">
          No active code yet. Ask the customer to generate one in their order, then{' '}
          <button type="button" className="text-button" onClick={() => void onChanged()}>
            check again
          </button>
          .
        </p>
      )}
      <form onSubmit={uploadPhoto} noValidate>
        <label className="field">
          Delivery photo (JPEG or PNG, up to 5 MB)
          <input
            type="file"
            accept="image/jpeg,image/png"
            capture="environment"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </label>
        <button className="button secondary" disabled={busy !== null}>
          {busy === 'photo' ? 'Uploading photo...' : 'Upload photo'}
        </button>
      </form>
    </section>
  );
}
