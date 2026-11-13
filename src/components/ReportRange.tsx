import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { errorText } from '../types';

/** Today in Asia/Saigon as YYYY-MM-DD. */
export function saigonToday(now = new Date()): string {
  return new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

/**
 * Converts inclusive local dates to the API's `[from,to)` instants: the start
 * of the first day and the start of the day after the last, in Asia/Saigon.
 */
export function rangeQuery(firstDay: string, lastDay: string): string {
  const from = `${firstDay}T00:00:00+07:00`;
  const to = `${addDays(lastDay, 1)}T00:00:00+07:00`;
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

export function useReport<T>(path: string | null) {
  const [first, setFirst] = useState(() => addDays(saigonToday(), -6)),
    [last, setLast] = useState(() => saigonToday()),
    [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!path) return;
    if (first > last) {
      setError('The first day must be on or before the last day.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      setData(await api(`${path}${path.includes('?') ? '&' : '?'}${rangeQuery(first, last)}`));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [path, first, last]);
  useEffect(() => {
    void load();
  }, [load]);
  const controls = (
    <div className="report-range">
      <label className="field">
        From (Asia/Saigon)
        <input type="date" value={first} max={last} onChange={(e) => setFirst(e.target.value)} />
      </label>
      <label className="field">
        To (inclusive)
        <input type="date" value={last} min={first} onChange={(e) => setLast(e.target.value)} />
      </label>
      <button type="button" className="button secondary small" onClick={() => void load()}>
        {loading ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
  );
  return { data, error, loading, controls, load };
}

/** Shows a number, or an explicit "No data" instead of a fake zero. */
export function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string | number | null;
  note?: string;
}) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value === null ? 'No data' : value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

export const minutes = (metric: { averageMinutes: number | null; coverage: any }) =>
  metric.averageMinutes === null ? null : `${metric.averageMinutes} min`;
export const coverageNote = (metric: { coverage: { withData: number; total: number } }) =>
  `${metric.coverage.withData} of ${metric.coverage.total} trips have this data`;
export const percent = (value: number | null) =>
  value === null ? null : `${Math.round(value * 1000) / 10}%`;
