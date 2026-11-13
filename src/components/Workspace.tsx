import { X } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, label, money } from '../api';
import { errorText } from '../types';
import { Field } from './Primitives';
import { InventoryHistory } from './InventoryHistory';
type OpeningDay = { day: number; intervals: Array<{ start: string; end: string }> };
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const emptySchedule = (): OpeningDay[] => weekdays.map((_, day) => ({ day, intervals: [] }));
export function RestaurantForm({
  restaurant: r,
  saved,
}: {
  restaurant: any;
  saved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
      name: r?.name || '',
      description: r?.description || '',
      address: r?.address || '',
      cuisine: r?.cuisine || 'Vietnamese',
      image: r?.image || '',
      phone: r?.phone || '',
    }),
    [flags, setFlags] = useState({
      catalog_visible: r?.catalog_visible ?? true,
      accepting_orders: r?.accepting_orders ?? true,
    }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [schedule, setSchedule] = useState<OpeningDay[] | null>(r?.opening_schedule ?? null);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api('/restaurants' + (r ? '/' + r.id : ''), r ? 'PATCH' : 'POST', {
            ...form,
            phone: form.phone.trim() || null,
            opening_schedule: schedule,
            ...(r ? flags : {}),
          });
          await saved();
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {Object.entries(form).map(([k, v]) => (
        <Field
          key={k}
          label={label(k)}
          value={v}
          required={k !== 'image' && k !== 'phone'}
          onChange={(e) => setForm({ ...form, [k]: e.target.value })}
        />
      ))}
      <fieldset className="opening-schedule">
        <legend>Structured opening hours</legend>
        <label className="option">
          <input
            type="checkbox"
            checked={schedule !== null}
            onChange={(event) => setSchedule(event.target.checked ? emptySchedule() : null)}
          />{' '}
          Use an opening schedule
        </label>
        {schedule === null ? (
          <p className="small-text muted">
            No structured schedule is enforced. Existing opening-hours text is kept for reference.
          </p>
        ) : (
          <>
            <p className="small-text muted">
              Days without intervals are closed. Split overnight hours across two days; an end time
              may be 24:00.
            </p>
            {weekdays.map((name, day) => {
              const entry = schedule.find((value) => value.day === day)!;
              return (
                <div className="opening-day" key={name}>
                  <strong>{name}</strong>
                  {entry.intervals.map((interval, index) => (
                    <div className="opening-interval" key={index}>
                      {(['start', 'end'] as const).map((part) => (
                        <label key={part}>
                          {part === 'start' ? 'Start' : 'End'}
                          <input
                            aria-label={`${name} interval ${index + 1} ${part}`}
                            value={interval[part]}
                            placeholder="HH:MM"
                            pattern={
                              part === 'start'
                                ? '(?:[01][0-9]|2[0-3]):[0-5][0-9]'
                                : '(?:(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00)'
                            }
                            required
                            onChange={(event) =>
                              setSchedule(
                                schedule.map((value) =>
                                  value.day === day
                                    ? {
                                        ...value,
                                        intervals: value.intervals.map((slot, i) =>
                                          i === index
                                            ? { ...slot, [part]: event.target.value }
                                            : slot,
                                        ),
                                      }
                                    : value,
                                ),
                              )
                            }
                          />
                        </label>
                      ))}
                      <button
                        type="button"
                        className="text-button"
                        onClick={() =>
                          setSchedule(
                            schedule.map((value) =>
                              value.day === day
                                ? {
                                    ...value,
                                    intervals: value.intervals.filter((_, i) => i !== index),
                                  }
                                : value,
                            ),
                          )
                        }
                      >
                        Remove interval
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="text-button"
                    disabled={entry.intervals.length >= 4}
                    onClick={() =>
                      setSchedule(
                        schedule.map((value) =>
                          value.day === day
                            ? { ...value, intervals: [...value.intervals, { start: '', end: '' }] }
                            : value,
                        ),
                      )
                    }
                  >
                    Add {name} interval
                  </button>
                </div>
              );
            })}
          </>
        )}
      </fieldset>
      {r && (
        <>
          <label className="option">
            <input
              type="checkbox"
              checked={flags.catalog_visible}
              onChange={(e) => setFlags({ ...flags, catalog_visible: e.target.checked })}
            />
            Listed in public catalog
          </label>
          <label className="option">
            <input
              type="checkbox"
              checked={flags.accepting_orders}
              onChange={(e) => setFlags({ ...flags, accepting_orders: e.target.checked })}
            />
            Accepting orders
          </label>
          <p className="small-text muted">
            Hiding the kitchen removes it from public search. Pausing orders keeps it visible with
            an “Orders paused” badge, but blocks checkout until you resume.
          </p>
        </>
      )}
      {!r && <p className="info">Your kitchen will be listed after administrator approval.</p>}
      <button className="button full" disabled={busy}>
        {busy ? 'Saving…' : r ? 'Save kitchen' : 'Submit for approval'}
      </button>
      {r && (
        <button
          type="button"
          className="text-button full"
          disabled={busy}
          onClick={async () => {
            if (
              !window.confirm(
                'Archive this kitchen? It will be hidden from customers and stop accepting orders. Existing orders are kept.',
              )
            )
              return;
            setBusy(true);
            try {
              await api('/restaurants/' + r.id, 'DELETE');
              await saved();
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Archive kitchen
        </button>
      )}
    </form>
  );
}
export function ItemForm({
  item: i,
  restaurantId,
  saved,
}: {
  item: any;
  restaurantId: string;
  saved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
      name: i?.name || '',
      description: i?.description || '',
      price: i?.price || 50000,
      stock: i?.stock ?? 30,
      category: i?.category || 'House favorites',
      available: i?.available ?? true,
      visible: i?.visible ?? true,
      image: i?.image || '',
    }),
    [options, setOptions] = useState<any[]>(i?.options || []),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [currentStock, setCurrentStock] = useState<number>(i?.stock ?? 0),
    [stockDelta, setStockDelta] = useState(''),
    [stockReason, setStockReason] = useState(''),
    [stockMessage, setStockMessage] = useState(''),
    [threshold, setThreshold] = useState<number>(i?.low_stock_threshold ?? 5),
    [thresholdDraft, setThresholdDraft] = useState<string>(String(i?.low_stock_threshold ?? 5)),
    [thresholdReason, setThresholdReason] = useState(''),
    [inventoryRevision, setInventoryRevision] = useState(0);
  const stockKeys = useRef<Record<string, string>>({});
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const { stock, ...editable } = form;
          await api(
            i ? '/items/' + i.id : `/restaurants/${restaurantId}/items`,
            i ? 'PATCH' : 'POST',
            { ...editable, ...(!i ? { stock } : {}), options },
          );
          await saved();
        } catch (e) {
          setError(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <Field
        label="Dish name"
        required
        minLength={2}
        value={form.name}
        onChange={(e) => setForm({ ...form, name: e.target.value })}
      />
      <Field
        label="Description"
        value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })}
      />
      <div className="form-grid">
        <Field
          label="Price (VND)"
          type="number"
          min={1000}
          required
          value={form.price}
          onChange={(e) => setForm({ ...form, price: Number(e.target.value) })}
        />
        {!i && (
          <Field
            label="Available servings"
            type="number"
            min={0}
            required
            value={form.stock}
            onChange={(e) => setForm({ ...form, stock: Number(e.target.value) })}
          />
        )}
      </div>
      <p className="small-text muted">
        Stock is the number still available, excluding servings reserved by pending orders.
      </p>
      {i && (
        <section className="stock-adjustment" aria-label="Stock adjustment">
          <p>
            Available servings: <strong>{currentStock}</strong>
          </p>
          <Field
            label="Stock change (+/-)"
            type="number"
            step={1}
            value={stockDelta}
            onChange={(e) => setStockDelta(e.target.value)}
          />
          <Field
            label="Stock adjustment reason"
            maxLength={300}
            value={stockReason}
            onChange={(e) => setStockReason(e.target.value)}
          />
          <button
            type="button"
            className="button secondary"
            disabled={
              busy ||
              !Number.isInteger(Number(stockDelta)) ||
              !Number(stockDelta) ||
              stockReason.trim().length < 3
            }
            onClick={async () => {
              const delta = Number(stockDelta),
                reason = stockReason.trim();
              const signature = JSON.stringify([delta, reason]);
              stockKeys.current[signature] ||= crypto.randomUUID();
              setBusy(true);
              setError('');
              setStockMessage('');
              try {
                const result = await api(`/items/${i.id}/stock-adjustments`, 'POST', {
                  delta,
                  reason,
                  idempotencyKey: stockKeys.current[signature],
                });
                setCurrentStock(result.stock);
                setStockDelta('');
                setStockReason('');
                setStockMessage('Stock adjustment saved.');
                setInventoryRevision((value) => value + 1);
                delete stockKeys.current[signature];
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Apply stock change
          </button>
          {stockMessage && <p role="status">{stockMessage}</p>}
          {currentStock <= threshold && (
            <p className="info">
              Low stock: {currentStock} remaining (threshold {threshold}).
            </p>
          )}
          <Field
            label="Low-stock threshold"
            type="number"
            min={0}
            max={100000}
            step={1}
            value={thresholdDraft}
            onChange={(event) => setThresholdDraft(event.target.value)}
          />
          <Field
            label="Threshold change reason"
            maxLength={300}
            value={thresholdReason}
            onChange={(event) => setThresholdReason(event.target.value)}
          />
          <button
            type="button"
            className="button secondary"
            disabled={
              busy ||
              thresholdDraft.trim() === '' ||
              !Number.isInteger(Number(thresholdDraft)) ||
              Number(thresholdDraft) < 0 ||
              Number(thresholdDraft) > 100000 ||
              thresholdReason.trim().length < 3
            }
            onClick={async () => {
              setBusy(true);
              setError('');
              setStockMessage('');
              try {
                const result = await api(`/items/${i.id}/stock-threshold`, 'PATCH', {
                  threshold: Number(thresholdDraft),
                  reason: thresholdReason.trim(),
                });
                setThreshold(result.threshold);
                setCurrentStock(result.stock);
                setThresholdReason('');
                setStockMessage('Low-stock threshold saved.');
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Save threshold
          </button>
          <InventoryHistory itemId={i.id} revision={inventoryRevision} />
        </section>
      )}
      <Field
        label="Menu category"
        required
        value={form.category}
        onChange={(e) => setForm({ ...form, category: e.target.value })}
      />
      <Field
        label="Image URL (HTTPS or local /images/ asset)"
        value={form.image}
        onChange={(e) => setForm({ ...form, image: e.target.value })}
      />
      <label className="option">
        <input
          type="checkbox"
          checked={form.visible}
          onChange={(e) => setForm({ ...form, visible: e.target.checked })}
        />
        Show on public menu
      </label>
      <label className="option">
        <input
          type="checkbox"
          checked={form.available}
          onChange={(e) => setForm({ ...form, available: e.target.checked })}
        />
        Available to order
      </label>
      <p className="small-text muted">
        Hidden dishes stay in your menu and order history but are not shown to customers.
        Unavailable dishes stay visible and show “Sold out”.
      </p>
      <h3>Optional extras</h3>
      {options.map((o, index) => (
        <div className="option-editor" key={o.id}>
          <Field
            label="Option name"
            required
            value={o.name}
            onChange={(e) =>
              setOptions(options.map((x, k) => (k === index ? { ...x, name: e.target.value } : x)))
            }
          />
          <Field
            label="Extra price"
            type="number"
            min={0}
            required
            value={o.extraPrice}
            onChange={(e) =>
              setOptions(
                options.map((x, k) =>
                  k === index ? { ...x, extraPrice: Number(e.target.value) } : x,
                ),
              )
            }
          />
          <button
            type="button"
            className="icon"
            aria-label="Remove option"
            onClick={() => setOptions(options.filter((_, k) => k !== index))}
          >
            <X size={18} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-button"
        onClick={() =>
          setOptions([...options, { id: crypto.randomUUID(), name: '', extraPrice: 0 }])
        }
      >
        + Add option
      </button>
      <button className="button full" disabled={busy}>
        {busy ? 'Saving…' : 'Save dish'}
      </button>
      {i && (
        <button
          type="button"
          className="text-button full"
          disabled={busy}
          onClick={async () => {
            if (
              !window.confirm(
                'Archive this dish? It will be hidden and unavailable for new orders. Past orders are kept.',
              )
            )
              return;
            setBusy(true);
            try {
              await api('/items/' + i.id, 'DELETE');
              await saved();
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Archive dish
        </button>
      )}
    </form>
  );
}
export function AdminPanels({
  overview: o,
  complaints,
  busy,
  action,
}: {
  overview: any;
  complaints: any[];
  busy: boolean;
  action: (p: string, b: unknown, m?: string) => Promise<void>;
}) {
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [accountReasons, setAccountReasons] = useState<Record<string, string>>({});
  return (
    <>
      <section className="panel">
        <h2>People & access</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Role</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {o.users.map((u: any) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.name}</strong>
                    <small>{u.email}</small>
                  </td>
                  <td>{label(u.role)}</td>
                  <td>{u.active ? 'Active' : 'Inactive'}</td>
                  <td>
                    <label>
                      Reason for changing {u.name}'s account
                      <input
                        value={accountReasons[u.id] || ''}
                        maxLength={300}
                        onChange={(event) =>
                          setAccountReasons({ ...accountReasons, [u.id]: event.target.value })
                        }
                      />
                    </label>
                    <button
                      className="button secondary small"
                      disabled={busy || (accountReasons[u.id] || '').trim().length < 3}
                      onClick={() =>
                        action(
                          '/admin/users/' + u.id,
                          { active: !u.active, reason: accountReasons[u.id] },
                          'PATCH',
                        )
                      }
                    >
                      {u.active ? 'Disable' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Support requests</h2>
        {complaints.length ? (
          complaints.map((c) => (
            <article className="support-request" key={c.id}>
              <div className="between">
                <strong>Order #{c.order_id.slice(0, 8)}</strong>
                <span className="status">{label(c.status)}</span>
              </div>
              <p>{c.content}</p>
              {c.status === 'OPEN' ? (
                <form
                  className="resolve-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    action(`/admin/complaints/${c.id}/resolve`, { resolution: resolutions[c.id] });
                  }}
                >
                  <Field
                    label="Resolution"
                    minLength={3}
                    required
                    value={resolutions[c.id] || ''}
                    onChange={(e) => setResolutions({ ...resolutions, [c.id]: e.target.value })}
                  />
                  <button className="button" disabled={busy}>
                    Resolve
                  </button>
                </form>
              ) : (
                <p>{c.resolution}</p>
              )}
            </article>
          ))
        ) : (
          <p className="muted">No support requests.</p>
        )}
      </section>
      <section className="panel">
        <h2>Review moderation</h2>
        {o.reviews.length ? (
          o.reviews.map((r: any) => (
            <div className="manage-item" key={r.id}>
              <div>
                <strong>
                  {r.rating}/5 · {r.hidden ? 'Hidden' : 'Published'}
                </strong>
                <p>{r.content}</p>
              </div>
              <button
                className="button secondary small"
                disabled={busy}
                onClick={() => action('/admin/reviews/' + r.id, { hidden: !r.hidden }, 'PATCH')}
              >
                {r.hidden ? 'Publish' : 'Hide'}
              </button>
            </div>
          ))
        ) : (
          <p className="muted">No reviews to moderate.</p>
        )}
      </section>
      <section className="panel">
        <h2>Recovery & reconciliation</h2>
        <p>
          {o.outbox.pending} pending notifications · {o.outbox.failed} exhausted retries
        </p>
        {o.reconciliation.length ? (
          o.reconciliation.map((p: any) => (
            <p key={p.id}>
              {p.reference} · {label(p.status)} · {money(p.amount)}
            </p>
          ))
        ) : (
          <p className="muted">No payments awaiting reconciliation.</p>
        )}
      </section>
      <section className="panel">
        <h2>Audit trail</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Resource</th>
              </tr>
            </thead>
            <tbody>
              {o.audit.map((a: any) => (
                <tr key={a.id}>
                  <td>{new Date(a.created_at).toLocaleString()}</td>
                  <td>{a.actor.slice(0, 12)}</td>
                  <td>{label(a.action)}</td>
                  <td>{a.resource_id.slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
