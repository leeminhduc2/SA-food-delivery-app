import { useState } from 'react';
import { money } from '../api';
import { coverageNote, Metric, minutes, percent, useReport } from './ReportRange';

/** Restaurant metrics with their definitions; gross values are not payouts. */
export function RestaurantDashboard({ restaurants }: { restaurants: any[] }) {
  const [chosen, setChosen] = useState('');
  const restaurantId = restaurants.some((r) => r.id === chosen) ? chosen : restaurants[0]?.id;
  const report = useReport<any>(
    restaurantId ? `/restaurants/${encodeURIComponent(restaurantId)}/reports` : null,
  );
  if (!restaurants.length) return null;
  const r = report.data;
  return (
    <section className="panel" aria-labelledby="restaurant-dashboard-heading">
      <h2 id="restaurant-dashboard-heading">Performance</h2>
      {restaurants.length > 1 && (
        <label className="field">
          Restaurant
          <select value={restaurantId} onChange={(e) => setChosen(e.target.value)}>
            {restaurants.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {report.controls}
      {report.error && (
        <p role="alert" className="form-error">
          {report.error}
        </p>
      )}
      {report.loading && !r && <p className="muted">Loading performance...</p>}
      {r && (
        <>
          <div className="stats" aria-live="polite">
            <Metric
              label="Delivered orders"
              value={r.delivered.count}
              note="By delivery completion time"
            />
            <Metric
              label="Gross delivered value"
              value={money(r.delivered.grossDeliveredValue)}
              note="Items plus delivery fee; not your payout"
            />
            <Metric
              label="Merchandise value"
              value={money(r.delivered.merchandiseValue)}
              note="Items only"
            />
            <Metric label="Failed deliveries" value={r.failed.count} />
            <Metric
              label="Delivery success rate"
              value={percent(r.successRate)}
              note="Delivered ÷ (delivered + failed)"
            />
            <Metric
              label="Refunds confirmed"
              value={money(r.refunded.amount)}
              note={`${r.refunded.count} refunds, by confirmation time; separate from delivered value`}
            />
            <Metric
              label="Average preparation"
              value={minutes(r.durations.prep)}
              note={coverageNote(r.durations.prep)}
            />
            <Metric
              label="Average wait for a driver"
              value={minutes(r.durations.assignmentWait)}
              note={coverageNote(r.durations.assignmentWait)}
            />
            <Metric
              label="Average delivery trip"
              value={minutes(r.durations.delivery)}
              note={coverageNote(r.durations.delivery)}
            />
          </div>
          {r.coverage.deliveredWithoutTimestamp > 0 && (
            <p className="small-text muted">
              {r.coverage.deliveredWithoutTimestamp} older delivered orders have no completion time
              and are not counted in any day.
            </p>
          )}
          <h3>Low stock</h3>
          {r.inventory.lowStock.length ? (
            <ul>
              {r.inventory.lowStock.map((item: any) => (
                <li key={item.id}>
                  {item.name}: {item.stock === 0 ? 'sold out' : `${item.stock} left`} (alert at{' '}
                  {item.threshold})
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No dishes are low on stock.</p>
          )}
        </>
      )}
    </section>
  );
}
