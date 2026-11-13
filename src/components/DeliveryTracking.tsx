import { useEffect, useRef, useState } from 'react';
import { AddressMap } from './DeliveryAddress';
import type { Actor } from '../types';

type Snapshot = {
  orderId: string;
  deliveryId: string | null;
  status: string;
  driver: { id: string; name: string } | null;
  location: { latitude: number; longitude: number } | null;
  routeMode: 'WALKING';
  capturedAt: string | null;
  stale: boolean;
  reason: string | null;
};
type Route = {
  destination: 'pickup' | 'dropoff';
  target: { name: string; latitude: number; longitude: number };
  sourceCapturedAt: string;
  distanceMeters: number;
  durationSeconds: number;
  routeGeometry: { type: 'LineString'; coordinates: [number, number][] };
};
type Pickup = { name: string; latitude: number | null; longitude: number | null } | null;
const terminal = (status: string) => ['DELIVERED', 'FAILED', 'CANCELLED'].includes(status);
const reasonText: Record<string, string> = {
  NO_DRIVER: 'A driver has not been assigned yet.',
  LOCATION_UNAVAILABLE: 'The assigned driver has not shared a location yet.',
  DRIVER_UNAVAILABLE: 'The assigned driver is currently unavailable.',
  ASSIGNMENT_CHANGED: 'The driver assignment changed. Checking the latest trip.',
  TERMINAL: 'This delivery has ended. Live location is no longer shared.',
};

export function DeliveryTracking({
  orderId,
  actor,
  pickup,
}: {
  orderId: string;
  actor: Actor;
  pickup: Pickup;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'live' | 'offline' | 'ended'>(
    'connecting',
  );
  const [error, setError] = useState('');
  const [destination, setDestination] = useState<'pickup' | 'dropoff'>('pickup');
  const [route, setRoute] = useState<Route | null>(null);
  const [routeError, setRouteError] = useState('');
  const [routeLoading, setRouteLoading] = useState(false);
  const routeController = useRef<AbortController | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const reloadRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let disposed = false,
      requestVersion = 0,
      blocked = false;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 3000;
    let poll: ReturnType<typeof setInterval> | undefined;
    const controller = new AbortController();
    const update = (next: Snapshot) => {
      if (disposed) return;
      if (snapshotRef.current?.driver?.id !== next.driver?.id) {
        routeController.current?.abort();
        setRoute(null);
        setRouteError('');
        setRouteLoading(false);
      }
      if (!next.location || next.stale) {
        routeController.current?.abort();
        setRoute(null);
        setRouteError('');
        setRouteLoading(false);
      }
      snapshotRef.current = next;
      setSnapshot(next);
      setError('');
      if (terminal(next.status)) {
        source?.close();
        source = undefined;
        if (retry) clearTimeout(retry);
        retry = undefined;
        stopPolling();
        setConnection('ended');
      }
    };
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = undefined;
    };
    const fetchSnapshot = async (): Promise<boolean> => {
      const version = ++requestVersion;
      try {
        const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/tracking`, {
          credentials: 'same-origin',
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          blocked = true;
          source?.close();
          source = undefined;
          if (retry) clearTimeout(retry);
          retry = undefined;
          routeController.current?.abort();
          stopPolling();
          snapshotRef.current = null;
          if (!disposed) {
            setSnapshot(null);
            setRoute(null);
            setRouteError('');
            setRouteLoading(false);
            setError('Tracking is no longer available for this account.');
          }
          return false;
        }
        if (!response.ok) throw new Error('Could not load tracking.');
        const data = (await response.json()) as Snapshot;
        if (!disposed && version === requestVersion) update(data);
        return true;
      } catch (failure) {
        if (!disposed && !(failure instanceof DOMException && failure.name === 'AbortError'))
          setError('Could not load tracking. Please retry.');
        return false;
      }
    };
    const startPolling = () => {
      if (!poll && !blocked) poll = setInterval(() => void fetchSnapshot(), 15000);
    };
    const scheduleReconnect = () => {
      if (retry || disposed || blocked || terminal(snapshotRef.current?.status ?? '')) return;
      const delay = retryDelay;
      retryDelay = Math.min(retryDelay * 2, 30000);
      retry = setTimeout(() => {
        retry = undefined;
        connect();
      }, delay);
    };
    const connect = () => {
      if (disposed || blocked || terminal(snapshotRef.current?.status ?? '')) return;
      if (typeof EventSource === 'undefined') {
        setConnection('offline');
        startPolling();
        return;
      }
      setConnection('connecting');
      startPolling();
      const current = new EventSource(`/api/orders/${encodeURIComponent(orderId)}/tracking/stream`);
      source = current;
      current.addEventListener('location', (event) => {
        if (disposed || source !== current) return;
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as Snapshot;
          if (!data || data.orderId !== orderId || typeof data.status !== 'string') return;
          requestVersion++;
          update(data);
        } catch {
          /* The next snapshot or heartbeat will recover. */
        }
      });
      current.addEventListener('tracking_status', (event) => {
        if (disposed || source !== current) return;
        try {
          const data = JSON.parse((event as MessageEvent<string>).data) as {
            status?: string;
            reason?: string;
            connected?: boolean;
          };
          if (data.reason === 'TERMINAL' || (data.status && terminal(data.status))) {
            current.close();
            source = undefined;
            stopPolling();
            if (snapshotRef.current)
              update({
                ...snapshotRef.current,
                status: data.status ?? snapshotRef.current.status,
                driver: null,
                location: null,
                capturedAt: null,
                stale: true,
                reason: 'TERMINAL',
              });
            return;
          }
          if (data.connected) {
            retryDelay = 3000;
            setConnection('live');
            stopPolling();
          } else {
            setConnection('offline');
            startPolling();
          }
        } catch {
          setConnection('offline');
          startPolling();
        }
      });
      current.addEventListener('revoked', () => {
        if (disposed || source !== current) return;
        current.close();
        source = undefined;
        requestVersion++;
        snapshotRef.current = null;
        routeController.current?.abort();
        if (!disposed) {
          setSnapshot(null);
          setRoute(null);
          setRouteError('');
          setRouteLoading(false);
          setConnection('offline');
          setError('Tracking changed. Checking access and the latest trip.');
        }
        startPolling();
        void fetchSnapshot().then(() => {
          scheduleReconnect();
        });
      });
      current.onerror = () => {
        if (!disposed && source === current) {
          setConnection('offline');
          startPolling();
          if (current.readyState === 2 && source === current && !retry && !blocked) {
            source = undefined;
            scheduleReconnect();
          }
        }
      };
    };
    reloadRef.current = () => {
      const wasBlocked = blocked;
      blocked = false;
      void fetchSnapshot().then((allowed) => {
        if (wasBlocked && allowed && !disposed) connect();
      });
    };
    void fetchSnapshot().then(() => {
      if (!disposed && !blocked) connect();
    });
    return () => {
      disposed = true;
      controller.abort();
      source?.close();
      stopPolling();
      if (retry) clearTimeout(retry);
      routeController.current?.abort();
      snapshotRef.current = null;
      reloadRef.current = () => undefined;
    };
  }, [orderId, actor.id, actor.role]);

  async function loadRoute() {
    routeController.current?.abort();
    const controller = new AbortController();
    routeController.current = controller;
    setRoute(null);
    setRouteError('');
    setRouteLoading(true);
    try {
      const response = await fetch(
        `/api/orders/${encodeURIComponent(orderId)}/tracking/route?destination=${destination}`,
        { credentials: 'same-origin', signal: controller.signal },
      );
      const data = await response.json();
      if (response.status === 401 || response.status === 403) {
        snapshotRef.current = null;
        setSnapshot(null);
        reloadRef.current();
      }
      if (!response.ok) throw new Error(data.message || 'Walking directions are unavailable.');
      if (!controller.signal.aborted) setRoute(data as Route);
    } catch (failure) {
      if (!controller.signal.aborted)
        setRouteError(
          failure instanceof Error ? failure.message : 'Walking directions are unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setRouteLoading(false);
    }
  }
  const marker: [number, number] | null = snapshot?.location
    ? [snapshot.location.latitude, snapshot.location.longitude]
    : null;
  const mapTarget =
    route?.target ??
    (pickup?.latitude != null && pickup.longitude != null
      ? { name: pickup.name, latitude: pickup.latitude, longitude: pickup.longitude }
      : null);
  return (
    <section className="delivery-tracking" aria-label="Delivery tracking">
      <div className="between tracking-heading">
        <h3>Delivery tracking</h3>
        <span className="tracking-connection" role="status">
          {connection === 'live'
            ? 'Live'
            : connection === 'connecting'
              ? 'Connecting'
              : connection === 'ended'
                ? 'Delivery ended'
                : 'Reconnecting · checking for updates'}
        </span>
      </div>
      {error && (
        <p className="info" role="alert">
          {error}{' '}
          <button type="button" className="text-button" onClick={() => reloadRef.current()}>
            Retry
          </button>
        </p>
      )}
      {!snapshot && !error && <p role="status">Loading tracking…</p>}
      {snapshot && (
        <>
          <p>{snapshot.driver ? `Driver: ${snapshot.driver.name}` : 'No driver available'}</p>
          {snapshot.reason && (
            <p className="info">
              {reasonText[snapshot.reason] ??
                (snapshot.stale ? 'The last location may be out of date.' : snapshot.reason)}
            </p>
          )}
          {snapshot.location && connection !== 'live' && connection !== 'ended' && (
            <p className="info">Live updates are unavailable; this position may be out of date.</p>
          )}
          {snapshot.capturedAt && (
            <p className="muted">
              {snapshot.stale || connection !== 'live'
                ? 'Last known location'
                : 'Location captured'}
              :{' '}
              <time dateTime={snapshot.capturedAt}>
                {new Date(snapshot.capturedAt).toLocaleTimeString()}
              </time>
              {snapshot.stale ? ' · out of date' : ''}
            </p>
          )}
          {marker ? (
            <>
              <p className="muted">
                Driver position: {marker[0].toFixed(5)}, {marker[1].toFixed(5)}.{' '}
                {route ? `Walking route to ${route.target.name}.` : 'No walking route displayed.'}
              </p>
              <AddressMap
                center={marker}
                marker={marker}
                restaurant={mapTarget}
                route={route?.routeGeometry}
                height={240}
              />
            </>
          ) : (
            <p className="muted">No live driver position to show on the map.</p>
          )}
          {actor.role === 'DRIVER' && !terminal(snapshot.status) && (
            <div className="navigation-controls">
              <label className="field">
                Walking destination
                <select
                  value={destination}
                  onChange={(event) => {
                    routeController.current?.abort();
                    setRoute(null);
                    setRouteError('');
                    setRouteLoading(false);
                    setDestination(event.target.value as 'pickup' | 'dropoff');
                  }}
                >
                  <option value="pickup">Pickup</option>
                  <option value="dropoff">Drop-off</option>
                </select>
              </label>
              <button
                type="button"
                className="button secondary"
                disabled={routeLoading || !marker || snapshot.stale}
                onClick={() => void loadRoute()}
              >
                {routeLoading
                  ? 'Loading directions…'
                  : route
                    ? 'Refresh walking route'
                    : 'Get walking route'}
              </button>
              {route && (
                <p>
                  Walking route to {route.target.name}: {(route.distanceMeters / 1000).toFixed(1)}{' '}
                  km · about {Math.ceil(route.durationSeconds / 60)} min.
                </p>
              )}
              {route && snapshot.capturedAt !== route.sourceCapturedAt && (
                <p className="info">
                  The driver's position changed. Refresh the route for updated directions.
                </p>
              )}
              {routeError && (
                <p className="info" role="alert">
                  {routeError}{' '}
                  <button type="button" className="text-button" onClick={() => void loadRoute()}>
                    Retry directions
                  </button>
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
