import { useCallback, useEffect, useRef, useState } from 'react';

type Availability = {
  online: boolean;
  ready: boolean;
  busy: boolean;
  locationFresh: boolean;
  heartbeatFresh: boolean;
  heartbeatAt: string | null;
};

export function DriverAvailability() {
  const [state, setState] = useState<Availability | null>(null);
  const [error, setError] = useState('');
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const watcher = useRef<number | null>(null);
  const lastSent = useRef(0);
  const sending = useRef(false);
  const alive = useRef(false);
  const controller = useRef<AbortController | null>(null);

  const call = useCallback(async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      signal: controller.current?.signal,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Request failed.');
    return data;
  }, []);
  const refresh = useCallback(async () => {
    try {
      const result = await call('/driver/availability');
      if (alive.current) setState(result);
    } catch (err) {
      if (alive.current && !(err instanceof DOMException && err.name === 'AbortError'))
        setError(err instanceof Error ? err.message : 'Could not load availability.');
    }
  }, [call]);
  useEffect(() => {
    alive.current = true;
    controller.current = new AbortController();
    void refresh();
    const poll = window.setInterval(() => void refresh(), 15000);
    return () => {
      alive.current = false;
      controller.current?.abort();
      window.clearInterval(poll);
      if (watcher.current !== null) navigator.geolocation.clearWatch(watcher.current);
      watcher.current = null;
    };
  }, [refresh]);
  useEffect(() => {
    if (!state?.online) return;
    const timer = window.setInterval(() => {
      void call('/driver/heartbeat', 'POST', {})
        .then((result) => {
          if (alive.current) setState(result);
        })
        .catch((err) => {
          if (alive.current) setError(err instanceof Error ? err.message : 'Heartbeat failed.');
        });
    }, 30000);
    return () => window.clearInterval(timer);
  }, [state?.online, call]);
  function enableLocation() {
    if (!navigator.geolocation) {
      setError('Location is unavailable on this device.');
      return;
    }
    if (watcher.current !== null) navigator.geolocation.clearWatch(watcher.current);
    setError('');
    watcher.current = navigator.geolocation.watchPosition(
      (position) => {
        if (!alive.current || sending.current || Date.now() - lastSent.current < 10000) return;
        sending.current = true;
        lastSent.current = Date.now();
        void call('/driver/location', 'POST', {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          capturedAt: new Date(position.timestamp).toISOString(),
        })
          .then(async () => {
            if (alive.current) {
              setWatching(true);
              setError('');
              await refresh();
            }
          })
          .catch((err) => {
            if (alive.current)
              setError(err instanceof Error ? err.message : 'Location update failed.');
          })
          .finally(() => {
            sending.current = false;
          });
      },
      (failure) => {
        if (!alive.current) return;
        if (watcher.current !== null) navigator.geolocation.clearWatch(watcher.current);
        watcher.current = null;
        setWatching(false);
        setError(
          failure.code === 1
            ? 'Location permission denied. Enable it in your browser settings, then try again.'
            : 'Location unavailable. Check your device and try again.',
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
  }
  async function change(patch: { online?: boolean; ready?: boolean }) {
    setBusy(true);
    setError('');
    try {
      const result = await call('/driver/availability', 'PATCH', patch);
      if (alive.current) setState(result);
    } catch (err) {
      if (alive.current) {
        setError(err instanceof Error ? err.message : 'Could not update availability.');
        await refresh();
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="panel" aria-labelledby="driver-availability-title">
      <h2 id="driver-availability-title">Driver availability</h2>
      {!state && !error && <p aria-live="polite">Loading availability…</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <button className="text-button" onClick={() => void refresh()}>
            Retry status
          </button>
        </p>
      )}
      {state && (
        <>
          <p>
            {state.online ? 'Online' : 'Offline'} · {state.ready ? 'Ready' : 'Not ready'} ·{' '}
            {state.busy ? 'On an active delivery' : 'No active delivery'}
          </p>
          <p>
            {state.locationFresh ? 'Location is recent' : 'Location missing or stale'}.{' '}
            {state.online && !state.heartbeatFresh ? 'Heartbeat is stale.' : ''}
          </p>
          <div className="row-actions">
            <button className="button secondary" onClick={enableLocation}>
              {watching ? 'Retry location' : 'Enable location'}
            </button>
            <button
              className="button"
              disabled={
                busy || (!state.online && !state.locationFresh) || (state.online && state.busy)
              }
              onClick={() => void change({ online: !state.online })}
            >
              {state.online ? 'Go offline' : 'Go online'}
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void change({ ready: !state.ready })}
            >
              {state.ready ? 'Set not ready' : 'Set ready'}
            </button>
          </div>
          {state.busy && (
            <p className="info">
              Finish your active delivery before going offline. You can still set yourself not
              ready.
            </p>
          )}
        </>
      )}
    </section>
  );
}
