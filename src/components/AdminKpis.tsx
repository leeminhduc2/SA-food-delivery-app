import { label, money } from '../api';
import { Metric, minutes, coverageNote, percent, useReport } from './ReportRange';

/** Platform KPIs. Live counts are "now"; cohort figures use the chosen local days. */
export function AdminKpis() {
  const report = useReport<any>('/admin/reports');
  const r = report.data;
  return (
    <section className="panel" aria-labelledby="admin-kpis-heading">
      <h2 id="admin-kpis-heading">Platform KPIs</h2>
      {report.controls}
      {report.error && (
        <p role="alert" className="form-error">
          {report.error}
        </p>
      )}
      {report.loading && !r && <p className="muted">Loading KPIs...</p>}
      {r && (
        <>
          <h3>Right now</h3>
          <div className="stats" aria-live="polite">
            <Metric
              label="Drivers online"
              value={r.live.drivers.online}
              note={r.definitions.online}
            />
            <Metric label="Drivers ready" value={r.live.drivers.ready} note={r.definitions.ready} />
            <Metric label="Drivers busy" value={r.live.drivers.busy} note={r.definitions.busy} />
            <Metric label="Searching for a driver" value={r.live.searching} />
            <Metric label="In transit" value={r.live.inTransit} />
            <Metric label="Awaiting payment" value={r.live.awaitingPayment} />
          </div>
          <h3>Selected days</h3>
          <div className="stats">
            <Metric label="Delivered" value={r.delivered.count} />
            <Metric label="Failed" value={r.failed.count} />
            <Metric
              label="Success rate"
              value={percent(r.successRate)}
              note="Delivered ÷ (delivered + failed), by terminal time"
            />
            <Metric
              label="Average delivery trip"
              value={minutes(r.durations.delivery)}
              note={coverageNote(r.durations.delivery)}
            />
            <Metric
              label="Gross delivered value"
              value={money(r.delivered.grossDeliveredValue)}
              note="Items plus delivery fees; not a payout"
            />
            <Metric
              label="Refunds confirmed"
              value={money(r.refunded.amount)}
              note={`${r.refunded.count} refunds; separate cohort`}
            />
          </div>
          <div className="table-wrap">
            <table>
              <caption>Orders placed in the selected days, by current status</caption>
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Orders</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(r.placedOrders.byStatus).length ? (
                  Object.entries(r.placedOrders.byStatus).map(([status, count]) => (
                    <tr key={status}>
                      <td>{label(status)}</td>
                      <td>{count as number}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={2}>No orders in this period.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
