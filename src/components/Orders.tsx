import { Bike, ChevronRight, MapPin, Star } from 'lucide-react';
import { useRef, useState } from 'react';
import { label, money } from '../api';
import type { Actor } from '../types';
import { Field } from './Primitives';
import { DeliveryTracking } from './DeliveryTracking';
export function OrderCard({
  order: o,
  actor,
  simulated,
  busy,
  action,
  drivers,
}: {
  order: any;
  actor: Actor;
  simulated: boolean;
  busy: boolean;
  action: (p: string, b: unknown, m?: string) => Promise<void>;
  drivers: any[];
}) {
  const [expanded, setExpanded] = useState(false),
    [reason, setReason] = useState(''),
    [rating, setRating] = useState(5),
    [content, setContent] = useState(''),
    [driver, setDriver] = useState(''),
    [overrideReason, setOverrideReason] = useState(''),
    [rejectionReason, setRejectionReason] = useState(''),
    [exceptionCode, setExceptionCode] = useState('NO_DRIVER'),
    [trackingOpen, setTrackingOpen] = useState(false),
    [support, setSupport] = useState(false);
  const arrivalKey = useRef(crypto.randomUUID());
  const overrideKeys = useRef<Record<string, string>>({});
  const rejectionKeys = useRef<Record<string, string>>({});
  const stages = [
    'PENDING_PAYMENT',
    'CONFIRMED',
    'ACCEPTED',
    'PREPARING',
    'READY_FOR_PICKUP',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
  ];
  const next: Record<string, string> = {
    CONFIRMED: 'ACCEPTED',
    ACCEPTED: 'PREPARING',
    PREPARING: 'READY_FOR_PICKUP',
  };
  const deliveryNext: Record<string, string> = {
    ASSIGNED: 'PICKED_UP',
    PICKED_UP: 'IN_TRANSIT',
    IN_TRANSIT: 'DELIVERED',
  };
  return (
    <article className="order-card">
      <div className="between">
        <span className="order-number">ORDER #{o.id.slice(0, 8).toUpperCase()}</span>
        <span className={'status ' + o.status}>{label(o.status)}</span>
      </div>
      <h2>{o.restaurant_name}</h2>
      <p className="muted">{new Date(o.created_at).toLocaleString()}</p>
      <div className="order-items">
        {o.items.map((i: any) => (
          <div key={i.id}>
            <span>
              {i.quantity} × {i.name}
              <small>{i.options.map((x: any) => x.name).join(', ')}</small>
            </span>
            <strong>{money(i.price * i.quantity)}</strong>
          </div>
        ))}
      </div>
      <div className="between total">
        <span>Including {money(o.delivery_fee)} delivery</span>
        <strong>{money(o.total)}</strong>
      </div>
      <div className="progress" aria-label={`Order status: ${label(o.status)}`}>
        {stages.map((s, i) => (
          <span key={s} className={i <= stages.indexOf(o.status) ? 'done' : ''} />
        ))}
      </div>
      <p className="address">
        <MapPin size={17} />
        {o.address}
      </p>
      {actor.role === 'DRIVER' && o.pickup && (
        <p className="address">
          Pickup: {o.pickup.name} · {o.pickup.address}
        </p>
      )}
      {o.note && <p className="info">Kitchen note: {o.note}</p>}
      <div className="state-pair">
        {actor.role !== 'DRIVER' && (
          <span>
            Payment<strong>{label(o.payment.status)}</strong>
          </span>
        )}
        <span>
          Delivery<strong>{label(o.delivery.status)}</strong>
        </span>
      </div>
      {o.delivery.driver_name && (
        <p className="muted">
          <Bike size={16} /> Your driver: {o.delivery.driver_name}
        </p>
      )}
      {o.delivery.arrived_at && (
        <p className="info">
          Driver arrived at pickup: {new Date(o.delivery.arrived_at).toLocaleTimeString()}
        </p>
      )}
      <details
        className="tracking-disclosure"
        onToggle={(event) => setTrackingOpen(event.currentTarget.open)}
      >
        <summary>Track delivery</summary>
        {trackingOpen && (
          <DeliveryTracking
            key={`${actor.id}:${o.id}`}
            orderId={o.id}
            actor={actor}
            pickup={o.pickup ?? null}
          />
        )}
      </details>
      {actor.role === 'DRIVER' && o.delivery.status === 'ASSIGNED' && !o.delivery.arrived_at && (
        <button
          className="button secondary full"
          disabled={busy}
          onClick={() =>
            action(`/deliveries/${o.delivery.id}/arrive`, { idempotencyKey: arrivalKey.current })
          }
        >
          Mark arrived at pickup
        </button>
      )}
      {actor.role === 'CUSTOMER' && o.status === 'PENDING_PAYMENT' && (
        <div className="payment-box">
          <strong>{simulated ? 'Simulated payment' : 'Awaiting payment'}</strong>
          <p>
            Complete by {new Date(o.expires_at).toLocaleTimeString()}. The kitchen receives your
            order after payment.
          </p>
          {simulated && (
            <div className="row-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => action(`/orders/${o.id}/simulate-payment`, { status: 'SUCCEEDED' })}
              >
                Simulate successful payment
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => action(`/orders/${o.id}/simulate-payment`, { status: 'FAILED' })}
              >
                Simulate failure
              </button>
            </div>
          )}
        </div>
      )}
      {actor.role === 'RESTAURANT' && next[o.status] && (
        <button
          className="button full"
          disabled={busy}
          onClick={() => action(`/orders/${o.id}/transition`, { status: next[o.status] })}
        >
          {label(next[o.status])}
          <ChevronRight size={17} />
        </button>
      )}
      {actor.role === 'RESTAURANT' && o.status === 'CONFIRMED' && (
        <details>
          <summary>Reject this order</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const reason = rejectionReason.trim();
              rejectionKeys.current[reason] ||= crypto.randomUUID();
              void action(`/orders/${o.id}/reject`, {
                reason,
                idempotencyKey: rejectionKeys.current[reason],
              });
            }}
          >
            <p className="muted">
              Reject before accepting. A successful payment enters the refund queue.
            </p>
            <Field
              label="Reason for rejection"
              required
              minLength={3}
              maxLength={300}
              value={rejectionReason}
              onChange={(event) => setRejectionReason(event.target.value)}
            />
            <button className="button secondary" disabled={busy}>
              Confirm rejection
            </button>
          </form>
        </details>
      )}
      {actor.role === 'RESTAURANT' &&
        ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(o.status) && (
          <p className="small-text muted">
            After acceptance, contact support if the order cannot be prepared.
          </p>
        )}
      {actor.role === 'DRIVER' && deliveryNext[o.delivery.status] && (
        <>
          <button
            className="button full"
            disabled={busy || (o.delivery.status === 'ASSIGNED' && o.status !== 'READY_FOR_PICKUP')}
            onClick={() =>
              action(`/deliveries/${o.delivery.id}/transition`, {
                status: deliveryNext[o.delivery.status],
              })
            }
          >
            {o.delivery.status === 'ASSIGNED' && o.status !== 'READY_FOR_PICKUP'
              ? 'Waiting for the kitchen'
              : label(deliveryNext[o.delivery.status])}
            <Bike size={18} />
          </button>
          {['PICKED_UP', 'IN_TRANSIT'].includes(o.delivery.status) && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action(`/deliveries/${o.delivery.id}/transition`, { status: 'FAILED', reason });
              }}
            >
              <Field
                label="Delivery issue"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
                minLength={3}
              />
              <button className="button secondary full" disabled={busy}>
                Report failed delivery
              </button>
            </form>
          )}
        </>
      )}
      {actor.role === 'ADMIN' &&
        ['UNASSIGNED', 'ASSIGNED'].includes(o.delivery.status) &&
        ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(o.status) && (
          <form
            className="assign"
            onSubmit={(e) => {
              e.preventDefault();
              const signature = JSON.stringify([driver, overrideReason.trim(), exceptionCode]);
              overrideKeys.current[signature] ||= crypto.randomUUID();
              action(`/admin/deliveries/${o.delivery.id}/reassign`, {
                driverId: driver,
                reason: overrideReason,
                exceptionCode,
                idempotencyKey: overrideKeys.current[signature],
              });
            }}
          >
            <label className="field">
              Assign a driver for an exception
              <select value={driver} required onChange={(e) => setDriver(e.target.value)}>
                <option value="">Choose a driver</option>
                {drivers.map((d) => (
                  <option value={d.id} key={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Exception
              <select value={exceptionCode} onChange={(e) => setExceptionCode(e.target.value)}>
                <option value="NO_DRIVER">No driver available</option>
                <option value="DRIVER_UNAVAILABLE">Driver unavailable</option>
                <option value="OPERATIONAL_ERROR">Operational error</option>
              </select>
            </label>
            <Field
              label="Reason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              required
              minLength={3}
              maxLength={300}
            />
            <button className="button small" disabled={busy}>
              Assign for exception
            </button>
          </form>
        )}
      {['CUSTOMER', 'RESTAURANT', 'ADMIN'].includes(actor.role) &&
        ['PENDING_PAYMENT', 'CONFIRMED'].includes(o.status) && (
          <details>
            <summary>Cancel this order</summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action(`/orders/${o.id}/cancel`, { reason });
              }}
            >
              <p className="muted">
                Available before acceptance. Successful payments enter the refund queue.
              </p>
              <Field
                label="Cancellation reason"
                required
                minLength={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <button className="button secondary" disabled={busy}>
                Confirm cancellation
              </button>
            </form>
          </details>
        )}
      {actor.role === 'CUSTOMER' && o.status === 'DELIVERED' && !o.review && (
        <details>
          <summary>How was your meal? Leave a review</summary>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await action(`/orders/${o.id}/review`, { rating, content });
            }}
          >
            <label className="field">
              Rating
              <select value={rating} onChange={(e) => setRating(Number(e.target.value))}>
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>
                    {n} stars
                  </option>
                ))}
              </select>
            </label>
            <Field
              label="Your review"
              required
              minLength={3}
              maxLength={1000}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
            <button className="button" disabled={busy}>
              Share review
            </button>
          </form>
        </details>
      )}
      {o.review && (
        <p className="info">
          <Star size={15} /> Your review: {o.review.rating}/5 · {o.review.content}
        </p>
      )}
      <button
        className="text-button full"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? 'Hide' : 'View'} order timeline
      </button>
      {expanded && (
        <ol className="timeline">
          {o.history.map((h: any) => (
            <li key={h.id}>
              <strong>
                {label(h.entity)} · {label(h.to_state)}
              </strong>
              <small>
                {new Date(h.created_at).toLocaleString()}
                {h.reason && ' · ' + h.reason}
              </small>
            </li>
          ))}
        </ol>
      )}
      {actor.role === 'CUSTOMER' && (
        <>
          <button className="text-button full" onClick={() => setSupport(!support)}>
            Need help with this order?
          </button>
          {support && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                await action(`/orders/${o.id}/complaints`, { content });
              }}
            >
              <Field
                label="Describe the issue"
                minLength={10}
                maxLength={2000}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                required
              />
              <button className="button secondary" disabled={busy}>
                Send to support
              </button>
            </form>
          )}
        </>
      )}
    </article>
  );
}
