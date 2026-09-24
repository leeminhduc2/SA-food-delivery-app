import { X } from 'lucide-react';
import { useState } from 'react';
import { api, label, money } from '../api';
import { errorText } from '../types';
import { Field } from './Primitives';
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
    }),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api('/restaurants' + (r ? '/' + r.id : ''), r ? 'PATCH' : 'POST', form);
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
          required={k !== 'image'}
          onChange={(e) => setForm({ ...form, [k]: e.target.value })}
        />
      ))}
      {!r && <p className="info">Your kitchen will be listed after administrator approval.</p>}
      <button className="button full" disabled={busy}>
        {busy ? 'Saving…' : r ? 'Save kitchen' : 'Submit for approval'}
      </button>
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
      image: i?.image || '',
    }),
    [options, setOptions] = useState<any[]>(i?.options || []),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api(
            i ? '/items/' + i.id : `/restaurants/${restaurantId}/items`,
            i ? 'PUT' : 'POST',
            { ...form, options },
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
        <Field
          label="Available servings"
          type="number"
          min={0}
          required
          value={form.stock}
          onChange={(e) => setForm({ ...form, stock: Number(e.target.value) })}
        />
      </div>
      <p className="small-text muted">
        Stock is the number still available, excluding servings reserved by pending orders.
      </p>
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
          checked={form.available}
          onChange={(e) => setForm({ ...form, available: e.target.checked })}
        />
        Available on menu
      </label>
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
                    <button
                      className="button secondary small"
                      disabled={busy}
                      onClick={() => action('/admin/users/' + u.id, { active: !u.active }, 'PATCH')}
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
