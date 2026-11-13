import { money } from '../api';
import { Metric, percent, useReport } from './ReportRange';

/** Driver's own performance; earnings are a labelled simulated estimate, never a payout. */
export function DriverPerformance() {
  const report = useReport<any>('/driver/reports');
  const r = report.data;
  return (
    <section className="panel" aria-labelledby="driver-performance-heading">
      <h2 id="driver-performance-heading">Performance and estimated earnings</h2>
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
            <Metric label="Delivered trips" value={r.delivered} />
            <Metric label="Failed trips" value={r.failed} />
            <Metric
              label="Success rate"
              value={percent(r.successRate)}
              note="Delivered ÷ (delivered + failed)"
            />
            <Metric
              label="Average trip"
              value={r.averageDeliveryMinutes === null ? null : `${r.averageDeliveryMinutes} min`}
              note={`${r.durationCoverage.withData} of ${r.durationCoverage.total} trips have pickup and drop-off times`}
            />
            <Metric
              label="Estimated earnings (not a payout)"
              value={money(r.estimatedEarnings.amount)}
              note={`${r.estimatedEarnings.trips} trips`}
            />
          </div>
          <p className="small-text muted">{r.estimatedEarnings.label}</p>
          {r.estimatedEarnings.deliveredWithoutEstimate > 0 && (
            <p className="small-text muted">
              {r.estimatedEarnings.deliveredWithoutEstimate} older trips have no estimate because
              their fee or final driver could not be confirmed.
            </p>
          )}
        </>
      )}
    </section>
  );
}
