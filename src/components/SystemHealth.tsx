import { useCallback, useEffect, useState } from 'react';
import { api, label } from '../api';
import { errorText } from '../types';

const when = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');

/** Durable work queues and provider breakers, with text status (not colour only). */
export function SystemHealth() {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api('/admin/health/backlog'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section className="panel" aria-labelledby="system-health-heading">
      <div className="between">
        <h2 id="system-health-heading">System health</h2>
        <button type="button" className="button secondary small" onClick={() => void load()}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {data && (
        <>
          <div className="table-wrap">
            <table>
              <caption>Background work queues</caption>
              <thead>
                <tr>
                  <th scope="col">Queue</th>
                  <th scope="col">Status</th>
                  <th scope="col">Waiting</th>
                  <th scope="col">Failed</th>
                  <th scope="col">Next run</th>
                  <th scope="col">Last error</th>
                </tr>
              </thead>
              <tbody>
                {data.queues.map((queue: any) => (
                  <tr key={queue.queue}>
                    <td>{label(queue.queue)}</td>
                    <td>
                      {queue.overdue ? 'Overdue' : queue.failed > 0 ? 'Needs attention' : 'OK'}
                    </td>
                    <td>{queue.pending}</td>
                    <td>{queue.failed}</td>
                    <td>{when(queue.nextRunAt)}</td>
                    <td>{queue.lastError ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>External providers</h3>
          {data.breakers.length ? (
            <ul>
              {data.breakers.map((item: any) => (
                <li key={item.name}>
                  {label(item.name)}: {label(item.state)}
                  {item.state === 'OPEN' && ` until ${when(item.retryAt)}`}
                  {item.consecutiveFailures > 0 && ` · ${item.consecutiveFailures} recent failures`}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No provider has been called by this server process yet.</p>
          )}
          <p className="small-text muted">{data.note}</p>
        </>
      )}
    </section>
  );
}
