# HTTP API

Base path: `/api`. JSON responses use ordinary HTTP status codes. Errors have `{ code, message, requestId }`. `X-Request-Id` is attached to every response. Send `Content-Type: application/json` and `X-Requested-With: Bep` on browser mutations. Authentication uses the `session` cookie issued by login/registration. Browser origins must be in comma-separated `APP_ORIGIN`.

**Interactive reference:** Swagger UI is served at [http://localhost:3001/api/docs](http://localhost:3001/api/docs) from the checked-in [`openapi.yaml`](../openapi.yaml) (OpenAPI 3.1); the raw document is at `/api/docs/openapi.yaml`. The spec declares the `session` cookie and the required `x-requested-with` header as security schemes. `npm run check:openapi` verifies that every registered route is documented.

## Identity and discovery

| Method/path                   | Access                      | Contract                                                                                                    |
| ----------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| POST `/auth/register`         | Public                      | `{name,email,password,role?}`; CUSTOMER default, RESTAURANT, or DRIVER. Driver returns pending approval.    |
| POST `/auth/login`            | Public                      | `{email,password}`; returns profile and sets session cookie.                                                |
| POST `/auth/logout`           | Session optional            | Invalidates current session.                                                                                |
| GET/PATCH `/auth/me`          | GET public, PATCH signed in | GET current profile/null; PATCH `{name}`.                                                                   |
| GET `/restaurants`            | Public                      | `q`, `cuisine`, `sort=recommended                                                                           | fee | name`; approved kitchens, search includes dishes. |
| GET `/restaurants/:id`        | Public for approved         | Restaurant, items, category names, extras and visible reviews. Unapproved access requires membership/admin. |
| GET `/manage/restaurants`     | Restaurant/Admin            | Owned restaurants, or all for admin.                                                                        |
| POST `/restaurants`           | Restaurant                  | `{name,description,address,cuisine,image?}` creates pending kitchen and membership.                         |
| PATCH `/restaurants/:id`      | Member/Admin                | Same profile fields; cannot self-approve or set fees.                                                       |
| POST `/restaurants/:id/items` | Member/Admin                | Item object below.                                                                                          |
| PUT `/items/:id`              | Member/Admin                | Full replacement of editable item fields.                                                                   |
| DELETE `/items/:id`           | Member/Admin                | Archives item by turning off availability; historical references remain.                                    |

Item fields: `{name,description,price,stock,available,image,category,options:[{id,name,extraPrice}]}`. Prices are whole VND. Image values may be HTTPS URLs, a local `/images/<filename>` path, or empty. Extra IDs must be unique within the dish.

## Basket, checkout and lifecycle

A line is `{itemId,quantity,optionIds:[]}`. Quantities must be 1–20 per line; at most 40 lines per request. Quotes do not reserve stock.

| Method/path                         | Access                               | Contract                                                                                         |
| ----------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| GET `/cart`                         | Customer                             | `{items,version}`; PostgreSQL-backed.                                                            |
| PUT `/cart`                         | Customer                             | `{items,version}`; empty array clears basket, stale version conflicts.                           |
| DELETE `/cart/items/:itemId`        | Customer                             | Removes one dish and returns the updated basket; 404 when it is not in the basket.               |
| POST `/checkout/quote`              | Customer                             | `{items}` → server prices, fee and total.                                                        |
| POST `/checkout`                    | Customer                             | `{items,address,note?,expectedTotal,idempotencyKey}` → existing/new detailed order.              |
| GET `/orders`                       | Signed in                            | Latest 100 visible orders; membership/assignment filters enforced server-side.                   |
| GET `/orders/:id`                   | Owner/member/assigned driver/Admin   | Order snapshots, independent payment/delivery state and history.                                 |
| POST `/orders/:id/transition`       | Owning restaurant                    | `{status}`: ACCEPTED → PREPARING → READY_FOR_PICKUP, from the correct preceding state.           |
| POST `/orders/:id/cancel`           | Owner/member/Admin                   | `{reason}`; only PENDING_PAYMENT or CONFIRMED.                                                   |
| POST `/orders/:id/simulate-payment` | Owning customer, simulated mode only | `{status: "SUCCEEDED"                                                                            | "FAILED"}`. Never available when simulation is disabled. |
| POST `/deliveries/:id/assign`       | Admin                                | `{driverId}`. Paid order, active driver, before pickup.                                          |
| POST `/deliveries/:id/transition`   | Active assigned driver               | `{status,reason?}`: PICKED_UP → IN_TRANSIT → DELIVERED; FAILED allowed after pickup with reason. |

Example checkout:

```json
{
  "items": [{ "itemId": "pho", "quantity": 1, "optionIds": ["extra"] }],
  "address": "12 Nguyễn Huệ, District 1, Ho Chi Minh City",
  "note": "Please pack the herbs separately.",
  "expectedTotal": 95000,
  "idempotencyKey": "customer-generated-unique-key"
}
```

Keep the same key and request body when retrying an uncertain checkout. `IDEMPOTENCY_CONFLICT` means that key was already used for different details. `PRICE_CHANGED` requires a fresh quote and customer confirmation. `OUT_OF_STOCK`, `UNAVAILABLE`, `SINGLE_RESTAURANT`, and `INVALID_OPTION` fail the whole transaction.

## Signed provider callback

`POST /payments/webhook` uses the **exact raw JSON bytes**. Set `X-Payment-Signature` to hex HMAC-SHA256 of those bytes using `PAYMENT_WEBHOOK_SECRET`. This generic contract is for the local simulator/reference adapter, not a commercial provider specification. It is exempt from the browser custom-header/origin flow.

```json
{
  "eventId": "provider-event-unique-id",
  "reference": "pay_<reference from order payment>",
  "orderId": "<order id>",
  "amount": 95000,
  "currency": "VND",
  "status": "SUCCEEDED",
  "externalTransactionId": "provider-transaction-id"
}
```

The server verifies signature, reference/order/amount/currency, immutable event identity, and transaction identity. Exact duplicates return `{duplicate:true}`. A late success creates refund/reconciliation work and does not restore a cancelled or expired order.

## Support and operations

| Method/path                            | Access                 | Contract                                                                                   |
| -------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| POST `/orders/:id/review`              | Buyer, delivered order | `{rating:1..5,content}`; one review per order.                                             |
| POST `/orders/:id/complaints`          | Buyer                  | `{content}`; at least 10 characters.                                                       |
| GET `/complaints`                      | Customer/Admin         | Customer's own requests, or all for admin.                                                 |
| GET `/notifications`                   | Signed in              | Own latest 50 inbox events.                                                                |
| POST `/notifications/read`             | Signed in              | Marks own inbox read.                                                                      |
| GET `/reports`                         | Restaurant/Admin       | Owned/global delivered revenue, counts, failure counts, daily activity.                    |
| GET `/admin/overview`                  | Admin                  | Restaurant/account queues, review moderation, audit, pending reconciliation/outbox counts. |
| POST `/admin/restaurants/:id/approval` | Admin                  | `{status:"APPROVED"                                                                        | "REJECTED"}`. |
| PATCH `/admin/users/:id`               | Admin                  | `{active}`; cannot disable self, disabling revokes sessions.                               |
| POST `/admin/complaints/:id/resolve`   | Admin                  | `{resolution}`; records audit and notification event.                                      |
| PATCH `/admin/reviews/:id`             | Admin                  | `{hidden}`; audit logged.                                                                  |
| GET `/health`                          | Public                 | DB connectivity; `{status:"ok"}`.                                                          |
| GET `/metrics`                         | Admin                  | Per-process request/error counts and p95/p99 over last 10,000 requests.                    |
| GET `/config`                          | Public                 | Demo/simulated-payment booleans only.                                                      |

Lists have fixed limits suitable for this phase; cursor pagination and full text indexing are future scale improvements. This is an explicit JSON API with server validation, not a public versioned API compatibility guarantee.
