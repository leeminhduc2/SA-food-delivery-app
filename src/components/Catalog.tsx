import { Plus } from 'lucide-react';
import { useState } from 'react';
import { money } from '../api';
export function Dish({
  item,
  busy,
  add,
}: {
  item: any;
  busy: boolean;
  add: (i: any, o: string[]) => void;
}) {
  const [options, setOptions] = useState<string[]>([]);
  return (
    <article className="dish">
      <img
        src={item.image || '/images/vietnamese.svg'}
        alt={`Illustration of ${item.name}`}
        loading="lazy"
      />
      <div className="dish-copy">
        <span className="eyebrow">{item.category}</span>
        <h3>{item.name}</h3>
        <p>{item.description}</p>
        {item.options.map((o: any) => (
          <label className="option" key={o.id}>
            <input
              type="checkbox"
              checked={options.includes(o.id)}
              onChange={(e) =>
                setOptions(
                  e.target.checked ? [...options, o.id] : options.filter((id) => id !== o.id),
                )
              }
            />
            {o.name} <span>+{money(o.extraPrice)}</span>
          </label>
        ))}
        <div className="between">
          <strong>
            {money(
              item.price +
                item.options
                  .filter((o: any) => options.includes(o.id))
                  .reduce((s: number, o: any) => s + o.extraPrice, 0),
            )}
          </strong>
          <button
            className="add-button"
            disabled={busy || !item.available || item.stock === 0}
            aria-label={`Add ${item.name}`}
            onClick={() => add(item, options)}
          >
            {!item.available || !item.stock ? (
              'Sold out'
            ) : (
              <>
                <Plus size={18} />
                Add
              </>
            )}
          </button>
        </div>
      </div>
    </article>
  );
}
