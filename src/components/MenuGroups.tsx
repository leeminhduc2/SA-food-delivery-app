import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { errorText } from '../types';

type Group = { id: string; name: string; _count: { items: number } };
export function MenuGroups({
  restaurantId,
  changed,
}: {
  restaurantId: string;
  changed: () => Promise<void>;
}) {
  const [groups, setGroups] = useState<Group[]>([]),
    [name, setName] = useState(''),
    [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const result: Group[] = await api(`/restaurants/${encodeURIComponent(restaurantId)}/menus`);
      setGroups(result);
      setDrafts(Object.fromEntries(result.map((group) => [group.id, group.name])));
      setError('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [restaurantId]);
  useEffect(() => {
    void load();
  }, [load]);
  async function perform(path: string, method: string, body?: unknown) {
    setBusy(true);
    try {
      await api(path, method, body);
      setName('');
      await load();
      await changed();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="menu-groups" aria-label="Menu groups">
      <h3>Menu groups</h3>
      <p className="small-text muted">
        Move all dishes, including hidden dishes, before deleting a group.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void perform(`/restaurants/${encodeURIComponent(restaurantId)}/menus`, 'POST', { name });
        }}
      >
        <label>
          New group name
          <input
            maxLength={60}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button className="button secondary" disabled={busy || !name.trim()}>
          Add group
        </button>
      </form>
      {loading && <p>Loading groups...</p>}
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" className="text-button" onClick={() => void load()}>
            Try again
          </button>
        </p>
      )}
      {!loading && !groups.length && <p>No menu groups yet.</p>}
      {groups.map((group) => (
        <form
          key={group.id}
          className="menu-group-row"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(`/menus/${encodeURIComponent(group.id)}`, 'PATCH', {
              name: drafts[group.id],
            });
          }}
        >
          <label>
            Group name
            <input
              aria-label={`Group name ${group.name}`}
              maxLength={60}
              required
              value={drafts[group.id] ?? ''}
              onChange={(event) => setDrafts({ ...drafts, [group.id]: event.target.value })}
            />
          </label>
          <span>{group._count.items} dishes</span>
          <button
            className="button secondary"
            disabled={busy || !drafts[group.id]?.trim() || drafts[group.id].trim() === group.name}
          >
            Rename
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy || group._count.items > 0}
            onClick={() => void perform(`/menus/${encodeURIComponent(group.id)}`, 'DELETE')}
          >
            Delete {group.name}
          </button>
        </form>
      ))}
    </section>
  );
}
