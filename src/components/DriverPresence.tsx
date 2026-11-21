import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  classifyLocationFailure,
  LOCATION_SEND_INTERVAL_MS,
  nextRetryDelay,
  RequestError,
} from './driver-location-errors';

export type DriverAvailability = {
  online: boolean;
  ready: boolean;
  busy: boolean;
  locationFresh: boolean;
  heartbeatFresh: boolean;
  heartbeatAt: string | null;
  version?: number;
};

export type LocationState =
  'disabled' | 'requesting' | 'acquiring' | 'sending' | 'active' | 'error';

export const locationStatus: Record<LocationState, string> = {
  disabled: 'Location sharing is off. Turn it on to be considered for delivery offers.',
  requesting: 'Requesting location permission…',
  acquiring: 'Acquiring location…',
  sending: 'Sending location…',
  active: 'Location is active.',
  error: 'Location error.',
};

type Presence = {
  state: DriverAvailability | null;
  error: string;
  locationState: LocationState;
  watching: boolean;
  busy: boolean;
  enableLocation: () => void;
  disableLocation: () => void;
  toggleOnline: () => void;
  toggleReady: () => void;
  refresh: () => Promise<void>;
};

const HEARTBEAT_INTERVAL_MS = 30_000;
const AVAILABILITY_POLL_MS = 15_000;
/** A stationary device may stop emitting watch updates; poll so GPS never goes stale. */
const LOCATION_POLL_MS = 20_000;

const PresenceContext = createContext<Presence | null>(null);

export function useDriverPresence(): Presence {
  const value = useContext(PresenceContext);
  if (!value) throw new Error('Driver presence is only available to signed-in drivers.');
  return value;
}

/**
 * Driver presence belongs to the signed-in session, not to one screen. Mounting
 * this above the router keeps location and heartbeats running on every page and
 * makes signing in enough to go online: the first accepted position flips the
 * driver to online and ready without another click.
 */
export function DriverPresenceProvider({
  driverId,
  children,
}: {
  driverId: string | null;
  children: ReactNode;
}) {
  const [state, setState] = useState<DriverAvailability | null>(null);
  const [error, setError] = useState('');
  const [locationState, setLocationState] = useState<LocationState>('disabled');
  const [watching, setWatching] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const watcher = useRef<number | null>(null);
  const locationTimer = useRef<number | null>(null);
  const nextSendAt = useRef(0);
  const retryDelay = useRef(LOCATION_SEND_INTERVAL_MS);
  const sending = useRef(false);
  const confirmed = useRef(false);
  const session = useRef(0);
  const autoActivated = useRef(false);
  const manualStop = useRef(false);

  const call = useCallback(async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      signal: controller.current?.signal,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'Bep' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new RequestError(
        data.message || 'Request failed.',
        response.status,
        typeof data.code === 'string' ? data.code : undefined,
      );
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

  function clearWatch() {
    if (watcher.current !== null) navigator.geolocation?.clearWatch(watcher.current);
    watcher.current = null;
    if (locationTimer.current !== null) window.clearInterval(locationTimer.current);
    locationTimer.current = null;
  }

  function resetSendState() {
    sending.current = false;
    confirmed.current = false;
    nextSendAt.current = 0;
    retryDelay.current = LOCATION_SEND_INTERVAL_MS;
  }

  /** Stop sharing with a message the driver can act on. */
  function stopSharing(token: number, message: string) {
    if (!alive.current || token !== session.current) return;
    clearWatch();
    resetSendState();
    setWatching(false);
    setLocationState('error');
    setError(message);
  }

  function failLocation(token: number, code: number) {
    stopSharing(
      token,
      code === 1
        ? 'Location permission denied. Enable it in your browser settings, then try again.'
        : code === 2
          ? 'Location is unavailable on this device. Check that location services are enabled.'
          : code === 3
            ? 'Timed out while acquiring your location. Move somewhere with a clearer signal and try again.'
            : 'Location is unavailable. Check your device and try again.',
    );
  }

  async function change(patch: { online?: boolean; ready?: boolean }, silent = false) {
    if (!silent) setBusy(true);
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
      if (!silent && alive.current) setBusy(false);
    }
  }

  /** Signing in should be the only step: go online once a position is accepted. */
  function activatePresence() {
    if (autoActivated.current || manualStop.current) return;
    autoActivated.current = true;
    void change({ online: true, ready: true }, true);
  }

  function sendPosition(position: GeolocationPosition, token: number) {
    if (!alive.current || token !== session.current) return;
    // One request at a time. The server owns the 5 s rate limit; the normal
    // cadence is 10 s and failures widen it up to LOCATION_MAX_RETRY_DELAY_MS.
    if (sending.current || Date.now() < nextSendAt.current) return;
    sending.current = true;
    nextSendAt.current = Date.now() + retryDelay.current;
    setLocationState('sending');
    void call('/driver/location', 'POST', {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      capturedAt: new Date(position.timestamp).toISOString(),
    })
      .then(async () => {
        if (!alive.current || token !== session.current) return;
        confirmed.current = true;
        retryDelay.current = LOCATION_SEND_INTERVAL_MS;
        nextSendAt.current = Date.now() + LOCATION_SEND_INTERVAL_MS;
        setLocationState('active');
        setError('');
        await refresh();
        activatePresence();
      })
      .catch((failure: unknown) => {
        if (!alive.current || token !== session.current) return;
        const decision = classifyLocationFailure(failure);
        if (decision.stop) {
          stopSharing(token, decision.message);
          return;
        }
        // A confirmed sharing session keeps showing "active" while a
        // recoverable error is retried; before the first success it is an error.
        setLocationState(confirmed.current ? 'active' : 'error');
        setError(decision.message);
        if (decision.backoff) {
          retryDelay.current = nextRetryDelay(retryDelay.current);
          nextSendAt.current = Date.now() + retryDelay.current;
        } else {
          retryDelay.current = LOCATION_SEND_INTERVAL_MS;
          nextSendAt.current = Date.now() + LOCATION_SEND_INTERVAL_MS;
        }
      })
      .finally(() => {
        // A late response from a previous session must not release the guard
        // for a request the new session already started.
        if (token === session.current) sending.current = false;
      });
  }

  function startLocation() {
    if (!driverId) return;
    if (!navigator.geolocation) {
      setLocationState('error');
      setError('Location is unavailable on this device.');
      return;
    }
    clearWatch();
    const token = ++session.current;
    resetSendState();
    setError('');
    setLocationState('requesting');
    if (typeof navigator.permissions?.query === 'function') {
      void navigator.permissions
        .query({ name: 'geolocation' })
        .then((status) => {
          if (!alive.current || token !== session.current) return;
          if (status.state === 'granted')
            setLocationState((current) => (current === 'requesting' ? 'acquiring' : current));
          status.onchange = () => {
            if (!alive.current || token !== session.current) return;
            if (status.state === 'granted')
              setLocationState((current) => (current === 'requesting' ? 'acquiring' : current));
            else if (status.state === 'denied') failLocation(token, 1);
          };
        })
        .catch(() => {
          if (token === session.current)
            setLocationState((current) => (current === 'requesting' ? 'acquiring' : current));
        });
    }
    watcher.current = navigator.geolocation.watchPosition(
      (position) => sendPosition(position, token),
      (failure) => failLocation(token, failure.code),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
    if (typeof navigator.geolocation.getCurrentPosition === 'function') {
      locationTimer.current = window.setInterval(() => {
        navigator.geolocation.getCurrentPosition(
          (position) => sendPosition(position, token),
          // A single timeout or unavailable fix is transient; permission denial is not.
          (failure) => {
            if (failure.code === 1) failLocation(token, failure.code);
          },
          { maximumAge: 0, timeout: 15000 },
        );
      }, LOCATION_POLL_MS);
    }
    setWatching(true);
  }

  function enableLocation() {
    manualStop.current = false;
    autoActivated.current = false;
    startLocation();
  }

  function disableLocation() {
    manualStop.current = true;
    session.current++;
    clearWatch();
    resetSendState();
    setWatching(false);
    setLocationState('disabled');
    setError('');
    void refresh();
  }

  useEffect(() => {
    if (!driverId) {
      alive.current = false;
      setState(null);
      setError('');
      setWatching(false);
      setLocationState('disabled');
      return;
    }
    alive.current = true;
    controller.current = new AbortController();
    autoActivated.current = false;
    manualStop.current = false;
    resetSendState();
    setState(null);
    setError('');
    setWatching(false);
    setLocationState('disabled');
    void refresh();
    const poll = window.setInterval(() => void refresh(), AVAILABILITY_POLL_MS);
    // Presence is implied by signing in; there is no separate "share location" step.
    startLocation();
    return () => {
      alive.current = false;
      session.current++;
      controller.current?.abort();
      controller.current = null;
      window.clearInterval(poll);
      clearWatch();
    };
    // Only a different driver restarts the session. The helpers above touch
    // refs and state setters, so stale closures cannot swallow an update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverId]);

  useEffect(() => {
    if (!driverId || !state?.online) return;
    const beat = () => {
      void call('/driver/heartbeat', 'POST', {})
        .then((result) => {
          if (alive.current) setState(result);
        })
        .catch((err) => {
          if (!alive.current) return;
          // Going offline intentionally is not an error; sync the new state.
          if (err instanceof RequestError && err.code === 'DRIVER_OFFLINE') {
            void refresh();
            return;
          }
          setError(err instanceof Error ? err.message : 'Heartbeat failed.');
        });
    };
    beat();
    const timer = window.setInterval(beat, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [driverId, state?.online, call, refresh]);

  const value: Presence = {
    state,
    error,
    locationState,
    watching,
    busy,
    enableLocation,
    disableLocation,
    toggleOnline: () => {
      if (state) void change({ online: !state.online });
    },
    toggleReady: () => {
      if (state) void change({ ready: !state.ready });
    },
    refresh,
  };
  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}
