import { locationStatus, useDriverPresence } from './DriverPresence';

/**
 * The availability panel is a view over the session-wide driver presence.
 * Location sharing and heartbeats keep running on every screen, so the
 * buttons here only control intent, not the lifetime of the presence.
 */
export function DriverAvailability() {
  const {
    state,
    error,
    locationState,
    watching,
    busy,
    enableLocation,
    disableLocation,
    toggleOnline,
    toggleReady,
    refresh,
  } = useDriverPresence();
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
          <p className="muted" aria-live="polite">
            {locationStatus[locationState]}
          </p>
          <div className="row-actions">
            <button
              className="button secondary"
              onClick={watching ? disableLocation : enableLocation}
            >
              {watching ? 'Stop sharing location' : 'Enable location'}
            </button>
            <button
              className="button"
              disabled={
                busy || (!state.online && !state.locationFresh) || (state.online && state.busy)
              }
              onClick={toggleOnline}
            >
              {state.online ? 'Go offline' : 'Go online'}
            </button>
            <button className="button secondary" disabled={busy} onClick={toggleReady}>
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
