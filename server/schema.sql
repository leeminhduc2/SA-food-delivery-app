CREATE TABLE IF NOT EXISTS users (
 id text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('CUSTOMER','RESTAURANT','DRIVER','ADMIN')), active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS restaurants (
 id text PRIMARY KEY, name text NOT NULL, description text NOT NULL, address text NOT NULL, cuisine text NOT NULL,
 image text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED')),
 delivery_fee integer NOT NULL DEFAULT 15000 CHECK(delivery_fee>=0), eta_minutes integer NOT NULL DEFAULT 30 CHECK(eta_minutes>0),
 approved_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS restaurant_members (user_id text NOT NULL REFERENCES users(id), restaurant_id text NOT NULL REFERENCES restaurants(id), PRIMARY KEY(user_id, restaurant_id));
CREATE TABLE IF NOT EXISTS menus (id text PRIMARY KEY, restaurant_id text NOT NULL REFERENCES restaurants(id), name text NOT NULL, UNIQUE(restaurant_id,name));
CREATE TABLE IF NOT EXISTS menu_items (
 id text PRIMARY KEY, restaurant_id text NOT NULL REFERENCES restaurants(id), menu_id text NOT NULL REFERENCES menus(id),
 name text NOT NULL, description text NOT NULL DEFAULT '', price integer NOT NULL CHECK(price>0), image text NOT NULL DEFAULT '',
 available boolean NOT NULL DEFAULT true, stock integer NOT NULL DEFAULT 30 CHECK(stock>=0), options jsonb NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS carts (customer_id text PRIMARY KEY REFERENCES users(id), items jsonb NOT NULL DEFAULT '[]', version integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS orders (
 id text PRIMARY KEY, customer_id text NOT NULL REFERENCES users(id), restaurant_id text NOT NULL REFERENCES restaurants(id),
 status text NOT NULL CHECK(status IN ('PENDING_PAYMENT','CONFIRMED','ACCEPTED','PREPARING','READY_FOR_PICKUP','OUT_FOR_DELIVERY','DELIVERED','CANCELLED','PAYMENT_FAILED','DELIVERY_FAILED')),
 subtotal integer NOT NULL CHECK(subtotal>=0), delivery_fee integer NOT NULL CHECK(delivery_fee>=0), total integer NOT NULL CHECK(total=subtotal+delivery_fee),
 currency text NOT NULL DEFAULT 'VND', address text NOT NULL, note text NOT NULL DEFAULT '',
 idempotency_key text NOT NULL, fingerprint text NOT NULL, stock_released boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(customer_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS order_items (
 id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), menu_item_id text NOT NULL REFERENCES menu_items(id),
 name text NOT NULL, price integer NOT NULL CHECK(price>0), quantity integer NOT NULL CHECK(quantity>0), options jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
 id text PRIMARY KEY, order_id text NOT NULL UNIQUE REFERENCES orders(id), reference text NOT NULL UNIQUE,
 amount integer NOT NULL CHECK(amount>0), currency text NOT NULL DEFAULT 'VND',
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','SUCCEEDED','FAILED','EXPIRED','REFUND_PENDING','REFUNDED')),
 external_transaction_id text UNIQUE, provider_created boolean NOT NULL DEFAULT false,
 reconciliation_required boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment_events (event_id text PRIMARY KEY, reference text NOT NULL REFERENCES payments(reference), payload_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE payments ADD COLUMN IF NOT EXISTS next_reconcile_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS simulated_transactions (reference text PRIMARY KEY, amount integer NOT NULL, status text NOT NULL DEFAULT 'PENDING', external_id text NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS deliveries (
 id text PRIMARY KEY, order_id text NOT NULL UNIQUE REFERENCES orders(id), driver_id text REFERENCES users(id),
 status text NOT NULL DEFAULT 'UNASSIGNED' CHECK(status IN ('UNASSIGNED','ASSIGNED','PICKED_UP','IN_TRANSIT','DELIVERED','FAILED','CANCELLED')),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS driver_assignments (id text PRIMARY KEY, delivery_id text NOT NULL REFERENCES deliveries(id), driver_id text NOT NULL REFERENCES users(id), active boolean NOT NULL DEFAULT true, assigned_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS assignment_active ON driver_assignments(delivery_id) WHERE active=true;
CREATE TABLE IF NOT EXISTS state_history (id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), entity text NOT NULL, from_state text, to_state text NOT NULL, actor text NOT NULL, reason text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE state_history ADD COLUMN IF NOT EXISTS sequence bigserial;
CREATE TABLE IF NOT EXISTS outbox (id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), type text NOT NULL, payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, last_error text);
CREATE TABLE IF NOT EXISTS notifications (id text PRIMARY KEY REFERENCES outbox(id), user_id text NOT NULL REFERENCES users(id), type text NOT NULL, payload jsonb NOT NULL, read boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS reviews (id text PRIMARY KEY, order_id text NOT NULL UNIQUE REFERENCES orders(id), customer_id text NOT NULL REFERENCES users(id), restaurant_id text NOT NULL REFERENCES restaurants(id), rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5), content text NOT NULL, hidden boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS complaints (id text PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), customer_id text NOT NULL REFERENCES users(id), content text NOT NULL, status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED')), resolution text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_logs (id text PRIMARY KEY, actor text NOT NULL, action text NOT NULL, resource_id text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS orders_restaurant ON orders(restaurant_id,status);
CREATE INDEX IF NOT EXISTS orders_pending ON orders(status,expires_at);
CREATE INDEX IF NOT EXISTS items_restaurant ON menu_items(restaurant_id);
CREATE INDEX IF NOT EXISTS deliveries_driver ON deliveries(driver_id,status);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(available_at) WHERE processed_at IS NULL;
