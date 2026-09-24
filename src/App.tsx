import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Bike,
  Check,
  Clock,
  Heart,
  LayoutDashboard,
  Leaf,
  LogOut,
  MapPin,
  Minus,
  Package,
  Pizza,
  Plus,
  Search,
  ShieldCheck,
  ShoppingBag,
  SlidersHorizontal,
  Soup,
  Star,
  Store,
  Utensils,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, label, money } from './api';
import { Auth, Profile } from './components/Account';
import { Dish } from './components/Catalog';
import { OrderCard } from './components/Orders';
import { Empty, Field, Modal } from './components/Primitives';
import { AdminPanels, ItemForm, RestaurantForm } from './components/Workspace';
import type { Actor, Basket, Line } from './types';
import { errorText } from './types';
export function App() {
  const [actor, setActor] = useState<Actor | null>(null),
    [config, setConfig] = useState<any>({}),
    [ready, setReady] = useState(false),
    [page, setPage] = useState(
      ['orders', 'workspace'].includes(location.hash.slice(1))
        ? location.hash.slice(1)
        : 'discover',
    );
  const [restaurants, setRestaurants] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(null),
    [query, setQuery] = useState(''),
    [cuisine, setCuisine] = useState(''),
    [sort, setSort] = useState('recommended'),
    [loading, setLoading] = useState(false);
  const [basket, setBasket] = useState<Basket>({ items: [], version: 0 }),
    [quote, setQuote] = useState<any>(null),
    [orderList, setOrderList] = useState<any[]>([]),
    [notifications, setNotifications] = useState<any[]>([]),
    [managed, setManaged] = useState<any[]>([]),
    [overview, setOverview] = useState<any>(null),
    [reports, setReports] = useState<any>(null),
    [complaints, setComplaints] = useState<any[]>([]);
  const [modal, setModal] = useState<string | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [menuItem, setMenuItem] = useState<any>(null),
    [managedRestaurant, setManagedRestaurant] = useState<any>(null);
  const [address, setAddress] = useState(''),
    [note, setNote] = useState('');
  const checkoutKey = useRef(crypto.randomUUID());
  const checkoutPayload = useRef<any>(null);
  const navigate = (p: string) => {
    location.hash = p;
    setPage(p);
    setSelected(null);
    setError('');
  };
  useEffect(() => {
    const listener = () => {
      const next = location.hash.slice(1) || 'discover';
      if (['discover', 'orders', 'workspace'].includes(next)) {
        setPage(next);
        setSelected(null);
      }
    };
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    Promise.all([api('/auth/me'), api('/config')])
      .then(([u, c]) => {
        setActor(u);
        setConfig(c);
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setReady(true));
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api('/restaurants?' + new URLSearchParams({ q: query, cuisine, sort }))
        .then((r) => {
          if (active) setRestaurants(r);
        })
        .catch((e) => {
          if (active) setError(errorText(e));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, cuisine, sort]);
  const refresh = useCallback(async () => {
    if (!actor) return;
    const [o, n] = await Promise.all([api('/orders'), api('/notifications')]);
    setOrderList(o);
    setNotifications(n);
    if (['ADMIN', 'RESTAURANT'].includes(actor.role)) {
      setReports(await api('/reports'));
      setManaged(await api('/manage/restaurants'));
    }
    if (actor.role === 'ADMIN') setOverview(await api('/admin/overview'));
    if (['CUSTOMER', 'ADMIN'].includes(actor.role)) setComplaints(await api('/complaints'));
  }, [actor]);
  useEffect(() => {
    if (!actor) {
      setBasket({ items: [], version: 0 });
      setQuote(null);
      setOrderList([]);
      return;
    }
    refresh().catch((e) => setError(errorText(e)));
    if (actor.role === 'CUSTOMER')
      api('/cart')
        .then(setBasket)
        .catch((e) => setError(errorText(e)));
    const interval = setInterval(() => {
      refresh().catch((e) => setError(errorText(e)));
    }, 7000);
    return () => clearInterval(interval);
  }, [actor, refresh]);
  useEffect(() => {
    let active = true;
    if (!basket.items.length) {
      setQuote(null);
      return;
    }
    api('/checkout/quote', 'POST', { items: basket.items })
      .then((q) => {
        if (active) setQuote(q);
      })
      .catch((e) => {
        if (active) {
          setQuote(null);
          setError(errorText(e));
        }
      });
    return () => {
      active = false;
    };
  }, [basket]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(timer);
  }, [notice]);
  async function openRestaurant(id: string) {
    await run(async () => {
      setSelected(await api('/restaurants/' + id));
      navigateToTop();
    });
  }
  const navigateToTop = () => window.scrollTo({ top: 0, behavior: 'instant' });
  async function saveBasket(items: Line[]) {
    try {
      const next = await api('/cart', 'PUT', { items, version: basket.version });
      setBasket(next);
      checkoutPayload.current = null;
      checkoutKey.current = crypto.randomUUID();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CART_CONFLICT') setBasket(await api('/cart'));
      throw e;
    }
  }
  async function add(item: any, optionIds: string[]) {
    if (!actor) {
      setModal('auth');
      return;
    }
    if (actor.role !== 'CUSTOMER') {
      setError('Sign in with a customer account to place an order.');
      return;
    }
    await run(async () => {
      const found = basket.items.find(
        (l) =>
          l.itemId === item.id &&
          JSON.stringify([...l.optionIds].sort()) === JSON.stringify([...optionIds].sort()),
      );
      const items = found
        ? basket.items.map((l) => (l === found ? { ...l, quantity: l.quantity + 1 } : l))
        : [...basket.items, { itemId: item.id, quantity: 1, optionIds }];
      await saveBasket(items);
      setNotice(`${item.name} added to your basket`);
    });
  }
  async function checkout() {
    await run(async () => {
      if (!quote) return;
      if (!checkoutPayload.current)
        checkoutPayload.current = {
          items: basket.items,
          address,
          note,
          expectedTotal: quote.total,
          idempotencyKey: checkoutKey.current,
        };
      try {
        await api('/checkout', 'POST', checkoutPayload.current);
        checkoutPayload.current = null;
        checkoutKey.current = crypto.randomUUID();
        setBasket(await api('/cart'));
        setModal(null);
        navigate('orders');
        await refresh();
        setNotice('Order placed. Complete your payment to send it to the kitchen.');
      } catch (e) {
        if (e instanceof ApiError && e.code === 'PRICE_CHANGED') {
          checkoutPayload.current = null;
          checkoutKey.current = crypto.randomUUID();
          setQuote(await api('/checkout/quote', 'POST', { items: basket.items }));
        }
        throw e;
      }
    });
  }
  async function action(path: string, body: unknown, method = 'POST') {
    await run(async () => {
      await api(path, method, body);
      await refresh();
      setNotice('Changes saved');
    });
  }
  const count = basket.items.reduce((s, l) => s + l.quantity, 0),
    isCustomer = !actor || actor.role === 'CUSTOMER';
  const nav = [
    { id: 'discover', text: 'Discover', icon: Utensils },
    ...(actor
      ? [
          {
            id: 'orders',
            text: actor.role === 'DRIVER' ? 'My deliveries' : 'Orders',
            icon: Package,
          },
        ]
      : []),
    ...(['RESTAURANT', 'ADMIN'].includes(actor?.role || '')
      ? [
          {
            id: 'workspace',
            text: actor?.role === 'ADMIN' ? 'Operations' : 'My kitchen',
            icon: LayoutDashboard,
          },
        ]
      : []),
  ];
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header>
        <div className="header-inner">
          <a className="brand" href="#discover" aria-label="Bếp home">
            <span className="brand-mark">
              <Utensils />
            </span>
            bếp<span className="brand-dot">.</span>
          </a>
          <nav aria-label="Main navigation">
            {nav.map((n) => (
              <a key={n.id} href={'#' + n.id} className={page === n.id ? 'active' : ''}>
                <n.icon size={17} />
                {n.text}
              </a>
            ))}
          </nav>
          <div className="header-actions">
            <span className="location">
              <MapPin size={17} />
              <span>
                Ho Chi Minh City<small>Good food, in your neighborhood</small>
              </span>
            </span>
            {actor && (
              <button
                className="icon notification"
                onClick={() => setModal('notifications')}
                aria-label="Notifications"
              >
                <Bell />
                {notifications.some((n) => !n.read) && <i />}
              </button>
            )}
            {isCustomer && (
              <button className="basket-button" onClick={() => setModal('basket')}>
                <ShoppingBag size={18} />
                <span>Basket</span>
                <b>{count}</b>
              </button>
            )}
            {actor ? (
              <button
                className="avatar"
                aria-label="Account settings"
                onClick={() => setModal('profile')}
              >
                {actor.name.slice(0, 1)}
              </button>
            ) : (
              <button className="button small" onClick={() => setModal('auth')}>
                Sign in
              </button>
            )}
          </div>
        </div>
      </header>
      {config.simulatedPayments && (
        <div className="demo-strip">
          <ShieldCheck size={14} />
          Local demo · Payments are simulated. No money is charged.
        </div>
      )}
      <main id="main" tabIndex={-1}>
        {error && (
          <div role="alert" className="alert">
            <span>{error}</span>
            <button className="icon" aria-label="Dismiss error" onClick={() => setError('')}>
              <X size={18} />
            </button>
          </div>
        )}
        {!ready ? (
          <div className="empty" role="status">
            Loading your neighborhood…
          </div>
        ) : page === 'discover' ? (
          <>
            {selected ? (
              <>
                <button className="text-button back" onClick={() => setSelected(null)}>
                  <ArrowLeft size={17} />
                  All restaurants
                </button>
                <section className="restaurant-hero">
                  <div>
                    <span className="eyebrow">YOUR NEIGHBORHOOD KITCHEN</span>
                    <h1>{selected.name}</h1>
                    <p>{selected.description}</p>
                    <div className="meta">
                      <span>
                        <Utensils size={16} />
                        {selected.cuisine}
                      </span>
                      <span>
                        <Clock size={16} />
                        {selected.eta_minutes}–{selected.eta_minutes + 10} min
                      </span>
                      <span>
                        <Bike size={16} />
                        {money(selected.delivery_fee)}
                      </span>
                    </div>
                    <p className="subtle">
                      <MapPin size={15} />
                      {selected.address}
                    </p>
                  </div>
                  <img
                    src={selected.image || '/images/vietnamese.svg'}
                    alt={`Illustration for ${selected.name}`}
                  />
                </section>
                <div className="section-title">
                  <div>
                    <span className="eyebrow">FRESH FROM THE KITCHEN</span>
                    <h2>The menu</h2>
                  </div>
                  <span>{selected.items.length} dishes</span>
                </div>
                <div className="menu-grid">
                  {selected.items.map((i: any) => (
                    <Dish key={i.id} item={i} busy={busy} add={add} />
                  ))}
                </div>
                <section className="reviews">
                  <h2>From the neighborhood</h2>
                  {selected.reviews.length ? (
                    selected.reviews.map((r: any, i: number) => (
                      <article key={i}>
                        <div className="between">
                          <strong>{r.name}</strong>
                          <span>
                            <Star size={14} /> {r.rating} / 5
                          </span>
                        </div>
                        <p>{r.content}</p>
                      </article>
                    ))
                  ) : (
                    <p className="muted">
                      No reviews yet. Order, enjoy, and be the first to share your experience.
                    </p>
                  )}
                </section>
              </>
            ) : (
              <>
                <section className="hero">
                  <div className="hero-copy">
                    <span className="eyebrow">
                      <span className="tiny-line" />
                      FROM LOCAL KITCHENS, WITH LOVE
                    </span>
                    <h1>
                      A little hungry?
                      <br />
                      You’re in the <em>right place.</em>
                    </h1>
                    <p>
                      Your favorite neighborhood flavors, freshly made.
                      <br className="desktop" /> Pick something delicious. We’ll bring it to you.
                    </p>
                    <a className="button" href="#restaurants">
                      Find your next favorite
                      <ArrowRight size={18} />
                    </a>
                    <div className="hero-note">
                      <span className="little-check">
                        <Check size={13} />
                      </span>
                      Local kitchens <span>·</span> Freshly prepared <span>·</span> Delivered with
                      care
                    </div>
                  </div>
                  <div className="hero-art">
                    <div className="orbit" />
                    <img
                      src="/images/hero.svg"
                      alt="Illustrated bowl of Vietnamese noodles with fresh herbs"
                    />
                    <span className="food-tag">
                      <span className="tag-icon">
                        <Leaf size={19} />
                      </span>
                      <span>
                        A little local goodness<small>Made fresh, just for you</small>
                      </span>
                    </span>
                    <span className="art-caption">GOOD FOOD. GOOD MOOD.</span>
                  </div>
                </section>
                <section className="discovery" id="restaurants">
                  <div className="section-title">
                    <div>
                      <span className="eyebrow">WHAT ARE YOU CRAVING?</span>
                      <h2>Find your kind of delicious.</h2>
                    </div>
                    <span className="local-label">
                      <MapPin size={15} />
                      Made around the corner
                    </span>
                  </div>
                  <div className="browse-tools">
                    <div className="categories">
                      {[
                        { name: 'All kitchens', value: '', icon: Utensils },
                        { name: 'Vietnamese', value: 'Vietnamese', icon: Soup },
                        { name: 'Italian', value: 'Italian', icon: Pizza },
                        { name: 'Healthy', value: 'Healthy', icon: Leaf },
                      ].map((c) => (
                        <button
                          key={c.value}
                          aria-pressed={cuisine === c.value}
                          className={'category ' + (cuisine === c.value ? 'selected' : '')}
                          onClick={() => setCuisine(c.value)}
                        >
                          <c.icon size={19} />
                          {c.name}
                        </button>
                      ))}
                    </div>
                    <div className="search-box">
                      <Search size={18} />
                      <input
                        aria-label="Search restaurants or dishes"
                        placeholder="A dish, a kitchen, a craving…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                      {query && (
                        <button
                          className="icon"
                          aria-label="Clear search"
                          onClick={() => setQuery('')}
                        >
                          <X size={15} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="result-line">
                    <span>
                      {loading
                        ? 'Finding your favorites…'
                        : `${restaurants.length} kitchens to fall in love with`}
                    </span>
                    <label>
                      <SlidersHorizontal size={15} />
                      <span className="sr-only">Sort restaurants</span>
                      <select value={sort} onChange={(e) => setSort(e.target.value)}>
                        <option value="recommended">Recommended</option>
                        <option value="fee">Lowest delivery fee</option>
                        <option value="name">Name A–Z</option>
                      </select>
                    </label>
                  </div>
                  <div className="restaurant-grid" aria-busy={loading}>
                    {restaurants.map((r, i) => (
                      <button
                        className="restaurant-card"
                        key={r.id}
                        onClick={() => openRestaurant(r.id)}
                      >
                        <div className={'card-image tone-' + i}>
                          <img
                            loading="lazy"
                            src={r.image || '/images/vietnamese.svg'}
                            alt={`Illustration of ${r.cuisine} food`}
                          />
                          <span className="image-label">
                            {i === 0
                              ? 'Neighborhood favorite'
                              : r.cuisine === 'Healthy'
                                ? 'Feel-good food'
                                : 'Made with love'}
                          </span>
                          <span className="image-arrow">
                            <ArrowRight size={18} />
                          </span>
                        </div>
                        <div className="card-copy">
                          <div className="between">
                            <h3>{r.name}</h3>
                            <span className="rating">
                              <Star size={14} />
                              {r.rating || 'New'}
                            </span>
                          </div>
                          <p>
                            {r.cuisine} <span>·</span> {r.description.split('.')[0]}
                          </p>
                          <div className="card-bottom">
                            <span>
                              <Clock size={15} />
                              {r.eta_minutes}–{r.eta_minutes + 10} min
                            </span>
                            <span>
                              <Bike size={16} />
                              {money(r.delivery_fee)}
                            </span>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                  {!loading && !restaurants.length && (
                    <Empty title="No kitchens found">
                      Try another dish or clear your filters.
                      <button
                        className="text-button"
                        onClick={() => {
                          setQuery('');
                          setCuisine('');
                        }}
                      >
                        Clear filters
                      </button>
                    </Empty>
                  )}
                </section>
                <section className="bottom-banner">
                  <div className="banner-icon">
                    <Store size={32} />
                  </div>
                  <div>
                    <span className="eyebrow">SMALL KITCHENS. BIG HEART.</span>
                    <h2>Every order supports a local story.</h2>
                    <p>Good food tastes even better when it comes from your community.</p>
                  </div>
                  <Heart size={42} strokeWidth={1} />
                </section>
              </>
            )}
          </>
        ) : page === 'orders' && actor ? (
          <>
            <div className="page-heading">
              <span className="eyebrow">
                {actor.role === 'DRIVER' ? 'ON THE ROAD' : 'EVERY STEP, RIGHT HERE'}
              </span>
              <h1>{actor.role === 'DRIVER' ? 'Your deliveries' : 'Your orders'}</h1>
              <p>Follow the journey from the kitchen to the doorstep.</p>
            </div>
            {!orderList.length ? (
              <Empty title="A fresh start">
                {isCustomer
                  ? 'Your next favorite meal is waiting.'
                  : 'New orders and assigned work will appear here.'}
              </Empty>
            ) : (
              <div className="order-grid">
                {orderList.map((o) => (
                  <OrderCard
                    key={o.id}
                    order={o}
                    actor={actor}
                    simulated={config.simulatedPayments}
                    busy={busy}
                    action={action}
                    drivers={
                      overview?.users.filter((u: any) => u.role === 'DRIVER' && u.active) || []
                    }
                  />
                ))}
              </div>
            )}
          </>
        ) : page === 'workspace' && actor && ['ADMIN', 'RESTAURANT'].includes(actor.role) ? (
          <>
            <div className="page-heading">
              <span className="eyebrow">
                {actor.role === 'ADMIN' ? 'PLATFORM OPERATIONS' : 'YOUR RESTAURANT WORKSPACE'}
              </span>
              <h1>{actor.role === 'ADMIN' ? 'Keep good food moving.' : 'Hello, chef.'}</h1>
              <p>
                {actor.role === 'ADMIN'
                  ? 'Manage approvals, people, and the details that make delivery work.'
                  : 'Your menu, your kitchen, your neighborhood.'}
              </p>
            </div>
            {reports && (
              <>
                <div className="stats">
                  {[
                    ['Total orders', reports.orders],
                    ['Delivered', reports.delivered],
                    ['Delivered revenue', money(reports.revenue)],
                    ['Delivery failures', reports.delivery_failed],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <span>{k}</span>
                      <strong>{v}</strong>
                    </div>
                  ))}
                </div>
                <p className="muted small-text">{reports.revenueBasis}</p>
              </>
            )}
            <div className="section-title">
              <h2>{actor.role === 'ADMIN' ? 'Restaurant approvals' : 'Your kitchens'}</h2>
              {actor.role === 'RESTAURANT' && (
                <button
                  className="button"
                  onClick={() => {
                    setManagedRestaurant(null);
                    setModal('restaurant');
                  }}
                >
                  <Plus size={18} />
                  Register kitchen
                </button>
              )}
            </div>
            <div className="manage-list">
              {(actor.role === 'ADMIN' ? overview?.restaurants || [] : managed).map((r: any) => (
                <article key={r.id} className="manage-row">
                  <img src={r.image || '/images/vietnamese.svg'} alt="" />
                  <div>
                    <h3>{r.name}</h3>
                    <p>
                      {r.cuisine} · {r.address}
                    </p>
                    <span className={'status ' + r.status}>{label(r.status)}</span>
                  </div>
                  <div className="row-actions">
                    {actor.role === 'ADMIN' && (
                      <>
                        <button
                          className="button small"
                          disabled={busy || r.status === 'APPROVED'}
                          onClick={() =>
                            action(`/admin/restaurants/${r.id}/approval`, { status: 'APPROVED' })
                          }
                        >
                          Approve
                        </button>
                        <button
                          className="button secondary small"
                          disabled={busy || r.status === 'REJECTED'}
                          onClick={() =>
                            action(`/admin/restaurants/${r.id}/approval`, { status: 'REJECTED' })
                          }
                        >
                          Reject
                        </button>
                      </>
                    )}
                    <button
                      className="button secondary small"
                      onClick={() =>
                        run(async () => {
                          setManagedRestaurant(await api('/restaurants/' + r.id));
                          setModal('menu');
                        })
                      }
                    >
                      Manage menu
                    </button>
                    <button
                      className="text-button"
                      onClick={() => {
                        setManagedRestaurant(r);
                        setModal('restaurant');
                      }}
                    >
                      Edit details
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {actor.role === 'ADMIN' && overview && (
              <AdminPanels
                overview={overview}
                complaints={complaints}
                busy={busy}
                action={action}
              />
            )}
            {reports?.daily.length > 0 && (
              <section className="panel">
                <h2>Daily activity</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Orders</th>
                        <th>Delivered revenue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reports.daily.map((d: any) => (
                        <tr key={d.day}>
                          <td>{d.day}</td>
                          <td>{d.orders}</td>
                          <td>{money(d.revenue)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        ) : (
          <Empty title="Sign in to continue">
            Choose an account to view this workspace.
            <button className="button" onClick={() => setModal('auth')}>
              Sign in
            </button>
          </Empty>
        )}
      </main>
      <footer>
        <a href="#discover" className="brand">
          bếp.
        </a>
        <span>Good food. Close to home.</span>
        <span>
          Made for the neighborhood <Heart size={13} />
        </span>
      </footer>
      {notice && (
        <div className="toast" role="status">
          <Check size={18} />
          {notice}
        </div>
      )}
      {modal === 'auth' && (
        <Modal title="Welcome to the neighborhood." close={() => setModal(null)}>
          <Auth
            demo={config.demoMode}
            onSuccess={(u) => {
              setActor(u);
              setModal(null);
              navigate(
                u.role === 'CUSTOMER' ? 'discover' : u.role === 'DRIVER' ? 'orders' : 'workspace',
              );
            }}
          />
        </Modal>
      )}
      {modal === 'basket' && (
        <Modal title="Your basket" close={() => setModal(null)}>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          {basket.items.length ? (
            <>
              <p className="muted">
                {quote?.restaurantName || 'Refresh your basket to check availability.'}
              </p>
              {basket.items.map((l, index) => {
                const i = quote?.items.find(
                  (v: any) =>
                    v.itemId === l.itemId &&
                    JSON.stringify(v.options.map((o: any) => o.id).sort()) ===
                      JSON.stringify([...l.optionIds].sort()),
                );
                return (
                  <div className="basket-line" key={index}>
                    <div>
                      <strong>{i?.name || l.itemId}</strong>
                      <small>{i?.options.map((o: any) => o.name).join(', ')}</small>
                      {i && <span>{money(i.price * l.quantity)}</span>}
                    </div>
                    <div className="stepper">
                      <button
                        aria-label={`Remove one ${i?.name || l.itemId}`}
                        disabled={busy}
                        onClick={() =>
                          run(() =>
                            saveBasket(
                              basket.items.flatMap((x, k) =>
                                k === index
                                  ? x.quantity > 1
                                    ? [{ ...x, quantity: x.quantity - 1 }]
                                    : []
                                  : [x],
                              ),
                            ),
                          )
                        }
                      >
                        <Minus size={15} />
                      </button>
                      <span>{l.quantity}</span>
                      <button
                        aria-label={`Add one ${i?.name || l.itemId}`}
                        disabled={busy || l.quantity >= 20}
                        onClick={() =>
                          run(() =>
                            saveBasket(
                              basket.items.map((x, k) =>
                                k === index ? { ...x, quantity: x.quantity + 1 } : x,
                              ),
                            ),
                          )
                        }
                      >
                        <Plus size={15} />
                      </button>
                    </div>
                  </div>
                );
              })}
              {quote && (
                <div className="totals">
                  <span>
                    Subtotal<b>{money(quote.subtotal)}</b>
                  </span>
                  <span>
                    Delivery<b>{money(quote.deliveryFee)}</b>
                  </span>
                  <span className="total">
                    Total<b>{money(quote.total)}</b>
                  </span>
                </div>
              )}
              <button
                className="button full"
                disabled={busy || !quote}
                onClick={() => setModal('checkout')}
              >
                Continue to checkout
                <ArrowRight size={18} />
              </button>
              <button
                className="text-button full"
                disabled={busy}
                onClick={() => run(() => saveBasket([]))}
              >
                Clear basket
              </button>
            </>
          ) : (
            <Empty title="Good things start with a craving.">
              Add a dish from a local kitchen to get started.
            </Empty>
          )}
        </Modal>
      )}
      {modal === 'checkout' && (
        <Modal title="One last thing. Where to?" close={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              checkout();
            }}
          >
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <Field
              label="Delivery address"
              required
              minLength={8}
              maxLength={300}
              placeholder="Street, building, apartment, district"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                checkoutPayload.current = null;
                checkoutKey.current = crypto.randomUUID();
              }}
            />
            <label className="field">
              Note for the kitchen
              <textarea
                maxLength={500}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  checkoutPayload.current = null;
                  checkoutKey.current = crypto.randomUUID();
                }}
                placeholder="Anything we should know?"
              />
            </label>
            <p className="info">
              {config.simulatedPayments
                ? 'This is a simulated online payment. You will confirm success or failure on the order screen.'
                : 'Online payment is required before the kitchen receives your order.'}
            </p>
            <div className="total between">
              <span>Total to pay</span>
              <strong>{money(quote?.total || 0)}</strong>
            </div>
            <button className="button full" disabled={busy || !quote}>
              {busy ? 'Placing your order…' : 'Place order'}
              <ArrowRight size={18} />
            </button>
          </form>
        </Modal>
      )}
      {modal === 'notifications' && (
        <Modal title="Your updates" close={() => setModal(null)}>
          <button className="text-button" onClick={() => action('/notifications/read', {})}>
            Mark all as read
          </button>
          {notifications.length ? (
            notifications.map((n) => (
              <div className={'notification-row ' + (!n.read ? 'unread' : '')} key={n.id}>
                <span className="little-check">
                  <Check size={14} />
                </span>
                <div>
                  <strong>{label(n.type)}</strong>
                  <p>
                    {n.payload.status
                      ? label(n.payload.status)
                      : n.payload.resolution || 'Your order is in the system.'}
                  </p>
                  <small>{new Date(n.created_at).toLocaleString()}</small>
                </div>
              </div>
            ))
          ) : (
            <Empty title="All quiet for now">Your order updates will appear here.</Empty>
          )}
        </Modal>
      )}
      {modal === 'profile' && actor && (
        <Modal title="Your account" close={() => setModal(null)}>
          <Profile actor={actor} setActor={setActor} />
          <p className="muted">
            {actor.email} · {label(actor.role)}
          </p>
          <button
            className="button secondary full"
            onClick={() =>
              run(async () => {
                await api('/auth/logout', 'POST');
                setActor(null);
                setModal(null);
                navigate('discover');
              })
            }
          >
            <LogOut size={17} />
            Sign out
          </button>
          {actor.role === 'CUSTOMER' && (
            <>
              <h3>Your support requests</h3>
              {complaints.length ? (
                complaints.map((c) => (
                  <div className="support-request" key={c.id}>
                    <span className="status">{label(c.status)}</span>
                    <p>{c.content}</p>
                    {c.resolution && (
                      <p>
                        <strong>Resolution:</strong> {c.resolution}
                      </p>
                    )}
                  </div>
                ))
              ) : (
                <p className="muted">No support requests.</p>
              )}
            </>
          )}
        </Modal>
      )}
      {modal === 'restaurant' && (
        <Modal
          title={managedRestaurant ? 'Edit kitchen' : 'Register your kitchen'}
          close={() => setModal(null)}
        >
          <RestaurantForm
            restaurant={managedRestaurant}
            saved={async () => {
              await refresh();
              setModal(null);
            }}
          />
        </Modal>
      )}
      {modal === 'menu' && managedRestaurant && (
        <Modal title={managedRestaurant.name + ' · Menu'} close={() => setModal(null)}>
          <button
            className="button"
            onClick={() => {
              setMenuItem(null);
              setModal('item');
            }}
          >
            <Plus size={17} />
            Add dish
          </button>
          {managedRestaurant.items?.map((i: any) => (
            <div className="manage-item" key={i.id}>
              <div>
                <strong>{i.name}</strong>
                <p>
                  {money(i.price)} · {i.stock} available · {i.available ? 'On menu' : 'Archived'}
                </p>
              </div>
              <button
                className="button secondary small"
                onClick={() => {
                  setMenuItem(i);
                  setModal('item');
                }}
              >
                Edit
              </button>
            </div>
          ))}
        </Modal>
      )}
      {modal === 'item' && managedRestaurant && (
        <Modal title={menuItem ? 'Edit dish' : 'Add a new dish'} close={() => setModal('menu')}>
          <ItemForm
            item={menuItem}
            restaurantId={managedRestaurant.id}
            saved={async () => {
              setManagedRestaurant(await api('/restaurants/' + managedRestaurant.id));
              setModal('menu');
            }}
          />
        </Modal>
      )}
    </>
  );
}
