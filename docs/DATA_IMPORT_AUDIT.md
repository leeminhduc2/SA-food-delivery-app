# Phase 0 — Audit: Hanoi Restaurant Data Import Service

Ngày audit: 2026-10-31
Phạm vi: workspace `SA-food-delivery-app`, nhánh hiện tại, database phát triển trong Docker Compose.

> Kết luận ngắn: workspace **đã có** một pipeline import OpenStreetMap hoàn chỉnh
> (fetch → normalize → validate → dedupe → protected upsert → job history → tests).
> Không cần tạo Catalog thứ hai và **không cần migration mới**. Có thể triển khai
> tính năng Hanoi bằng cách mở rộng pipeline này, dùng các cột provenance/JSONB
> sẵn có để lưu nguồn, license và dấu demo.

## 1. Kiến trúc hiện tại

```text
React + Vite (src/)
        │  /api
        ▼
Express 5 routes (server/modules/*/*.routes.ts)
        │
        ▼
Application (server/modules/*/application/*) — business rules, transactions
        │
        ▼
Infrastructure (server/modules/*/infrastructure/*) — Prisma Client
        │
        ▼
PostgreSQL 17 (Docker Compose, port 5433)
```

Các điểm chính:

- Express 5, TypeScript strict, Prisma 6.19.3. Prisma là lớp truy cập DB duy nhất
  trong ứng dụng; `pg` chỉ còn cho test schema và script E2E.
- Migration: chỉ có baseline `prisma/migrations/20261031000000_baseline` và
  `migration_lock.toml`. Baseline đã được adopt trên database phát triển; không
  được sửa file baseline.
- Test: Node test runner (`tsx --test --test-concurrency=1`) + Playwright.
- API contract: `openapi.yaml` (OpenAPI 3.1), kiểm tra bởi `npm run check:openapi`.
- Seed: `server/seed/seed.ts` chỉ chạy khi `DEMO_MODE=true`, upsert 6 user, 3 nhà hàng
  demo TP.HCM và 8 món; không xóa dữ liệu hiện có.

### Pipeline import OSM đã có

| Thành phần      | File                                                            | Vai trò                                                                                                                |
| --------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Overpass client | `server/modules/catalog/import/overpass.client.ts`              | POST query, timeout, retry/backoff, `Retry-After`, giới hạn element, coalescing request trùng                          |
| Normalizer      | `server/modules/catalog/import/osm.ts`                          | Lọc `amenity`, tên, toạ độ; dedupe theo `type/id`; giữ `addr:*`; đếm field thiếu; không bịa dữ liệu                    |
| Import service  | `server/modules/catalog/import/restaurant-import.service.ts`    | fetch → normalize → classify → persist theo batch; savepoint từng record; job history; dry-run                         |
| Repository      | `server/modules/catalog/import/restaurant-import.repository.ts` | Protected upsert bằng raw SQL; không ghi đè row `verified` hoặc `owner_managed`; ownership snapshot; job CRUD          |
| Admin API       | `server/modules/catalog/import/import.routes.ts`                | `POST /api/admin/restaurants/import`, `GET .../history`; chỉ ADMIN; rate limit                                         |
| CLI             | `scripts/import-restaurants.ts`                                 | `npm run import:restaurants -- [--dry-run] [--json] [--bbox]`                                                          |
| Tests           | `tests/restaurant-import.test.ts`                               | 13 test: retry, timeout, normalize, dedupe, empty, protected upsert, dry-run, savepoint, DB failure, auth, job history |

Hành vi bảo vệ hiện tại:

- Chỉ cập nhật row khi `source='OSM' AND verified=false AND owner_managed=false`.
- Record mới được ghi `PENDING`, `verified=false`, `owner_managed=false`,
  `delivery_fee=0`, `image=''`, `description=''`.
- Không xóa row, không reset, không truncate.

## 2. Database schema

Nguồn: `prisma/schema.prisma` và baseline migration. Database phát triển hiện có
**3 restaurants, 3 menus, 8 menu_items, 6 users, 1 order**; cả 3 nhà hàng là
`source='MANUAL'`, `status='APPROVED'`.

### `restaurants`

Các cột quan trọng:

- Định danh/nội dung: `id`, `name`, `description`, `address`, `cuisine`, `image`.
- Vận hành: `status` (`PENDING|APPROVED|REJECTED`), `delivery_fee`, `eta_minutes`,
  `approved_at`, `created_at`.
- Provenance: `source` (default `MANUAL`), `verified`, `owner_managed`,
  `osm_type`, `osm_id`, `latitude`, `longitude`, `phone`, `website`,
  `opening_hours`, `address_tags JSONB`, `osm_tags JSONB`, `imported_at`,
  `last_synced_at`.
- Unique index một phần: `(osm_type, osm_id)` khi cả hai khác NULL — đảm bảo
  idempotency theo danh tính OSM.
- Không có cột `slug`, `cover_image`, `ward/district/city`, `minimum_order`,
  `image_license`, `demo_menu`.
- `address_tags` đã đủ lưu `addr:ward`, `addr:district`, `addr:city`,
  `addr:street`, `addr:housenumber`, `addr:full`.
- `osm_tags` là JSONB tự do, đủ để lưu metadata có namespace
  (`_bep.menu`, `_bep.image`, `_bep.sourceUrl`, `_bep.license`) mà không cần
  migration.
- CHECK constraints: `status IN (...)`, `delivery_fee >= 0`, `eta_minutes > 0`.

### `menus` và `menu_items`

- `menus`: `id`, `restaurant_id`, `name`; unique `(restaurant_id, name)`.
  **Category của món hiện được biểu diễn bằng tên Menu**, không phải cột trên
  `menu_items`.
- `menu_items`: `id`, `restaurant_id`, `menu_id`, `name`, `description`, `price`,
  `image`, `available`, `stock` (default 30), `options JSONB` (default `[]`).
- Không có unique constraint trên `(menu_id, name)`. Idempotency của menu demo
  phải dựa trên **ID xác định** (deterministic) + `createMany({ skipDuplicates })`.
- Không có cột metadata riêng cho menu/món. Dấu demo sẽ lưu ở
  `restaurants.osm_tags._bep.menu` và mọi món demo dùng ID có tiền tố `demo-`.
- `price` là INTEGER VND; API validation 1.000–10.000.000.

### Kết luận schema

Không cần migration mới. Các yêu cầu provenance, toạ độ, phường/quận/thành phố,
license ảnh và dấu menu demo đều biểu diễn được bằng các cột/JSONB hiện có. Điều
này tránh thay đổi baseline và tránh ảnh hưởng tới API/Prisma Client.

## 3. API hiện có

Các endpoint Catalog hiện có:

| Method | Path                                    | Ghi chú                                                                                                                    |
| ------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/restaurants`                      | Chỉ trả `status='APPROVED'`; query `q`, `cuisine`, `sort=recommended                                                       | fee | name`; tối đa 100; kèm `rating`, `review_count`, và toàn bộ scalar của restaurant (bao gồm `osm_tags`, `address_tags`) |
| GET    | `/api/restaurants/:id`                  | Trả restaurant + `items` (category lấy từ `menu.name`) + `reviews`; row không APPROVED chỉ cho RESTAURANT/ADMIN thành viên |
| POST   | `/api/restaurants`                      | Đăng ký nhà hàng, PENDING                                                                                                  |
| PATCH  | `/api/restaurants/:id`                  | Chủ nhà hàng/Admin cập nhật; đặt `owner_managed=true`                                                                      |
| GET    | `/api/manage/restaurants`               | Danh sách quản lý                                                                                                          |
| POST   | `/api/restaurants/:id/items`            | Thêm món; category → upsert Menu                                                                                           |
| PUT    | `/api/items/:id`                        | Sửa món                                                                                                                    |
| DELETE | `/api/items/:id`                        | Archive món (available=false)                                                                                              |
| POST   | `/api/admin/restaurants/import`         | Queue import OSM theo bbox; PENDING                                                                                        |
| GET    | `/api/admin/restaurants/import/history` | Lịch sử job                                                                                                                |

Không có endpoint `/restaurants/:id/menu` riêng — menu nằm trong response detail.
Không có endpoint facet cuisine; frontend đang hardcode 4 chip
`All / Vietnamese / Italian / Healthy`.

Các field provenance hiện đã có trong JSON response nhưng **chưa được khai báo
trong `openapi.yaml`** (`latitude`, `longitude`, `phone`, `website`,
`opening_hours`, `source`, `verified`, `osm_tags`, `address_tags`, ...). Đây là
khoảng trống contract, không phải khoảng trống dữ liệu.

## 4. Frontend hiện tại

`src/App.tsx`:

- Discover: gọi `GET /restaurants?q=&cuisine=&sort=` với debounce 200 ms.
- Detail: gọi `GET /restaurants/:id`, hiển thị hero ảnh, tên, mô tả, cuisine,
  ETA, phí giao, địa chỉ, toàn bộ món trong một grid phẳng, reviews.
- Card: ảnh `r.image || '/images/vietnamese.svg'`, `loading="lazy"`, cuisine,
  mô tả, ETA, phí.
- Search/filter/sort đã hoạt động; loading/empty/error đã có ở mức cơ bản.
- Filter cuisine hardcode 4 lựa chọn; không lấy từ dữ liệu.
- Chưa hiển thị phone/website/opening_hours/source/demo marker.
- Ảnh chưa có `onError` fallback.
- Menu chưa nhóm theo category (dù API trả `category`).
- `src/components/Catalog.tsx` render món, `loading="lazy"`, nhưng cũng chưa có
  fallback khi ảnh lỗi.
- Cart/checkout/payment/delivery dùng ID món và API hiện có; thay đổi chỉ được
  phép ở phần hiển thị/metadata, không đổi shape line item.

Ảnh hiện có: 6 SVG nội bộ trong `public/images/` (`hero`, `vietnamese`, `pizza`,
`rice`, `sandwich`, `healthy`). Footer đã có attribution OSM/ODbL.

## 5. Phần có thể tái sử dụng

| Nhu cầu                                                     | Tái sử dụng                                               |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| Gọi Overpass, retry, timeout, giới hạn                      | `fetchOsmRestaurants` (mở rộng nhận query tuỳ biến)       |
| Chuẩn hoá OSM, validate toạ độ/tên, dedupe, đếm field thiếu | `normalizeOsmElements` (bổ sung `cafe`)                   |
| Upsert idempotent, bảo vệ row verified/owner-managed        | `upsertImportedRestaurant` + partial unique index         |
| Ghi batch có savepoint                                      | `persistNormalizedRestaurants`                            |
| Job history                                                 | `createImportJob` / `finishImportJob` / `listImportJobs`  |
| Menu/category                                               | `menu.upsertMenu`, `menu.insert`, `menu.listByRestaurant` |
| API danh sách/detail/tìm kiếm/lọc/sort                      | `catalog.service` + `restaurant.repository.search`        |
| Ảnh placeholder                                             | 6 SVG hiện có; bổ sung bộ SVG minh hoạ mới                |
| Attribution                                                 | Footer OSM/ODbL hiện có                                   |

## 6. Khoảng trống và rủi ro

### Khoảng trống chức năng

1. Importer generic tạo `PENDING`, `image=''`, `description=''`, không có menu.
   Dữ liệu này không hiển thị công khai và không đủ cho demo.
2. Chưa có danh sách 30 OSM ID Hà Nội được tuyển chọn và chưa có menu demo.
3. Chưa có dấu demo rõ ràng trong DB/API/UI.
4. Chưa có metadata license/nguồn ảnh; ảnh placeholder hiện dùng chung vài file.
5. Frontend hardcode cuisine chips; chưa hiển thị phone/website/opening_hours,
   chưa nhóm menu theo category, chưa có fallback ảnh lỗi.
6. `openapi.yaml` chưa mô tả các field provenance vốn đã có trong response.
7. Chưa có test riêng cho curated import/menu demo/idempotency bảo vệ dữ liệu.

### Rủi ro kỹ thuật

- Overpass là dịch vụ công cộng: phải một request/lần, timeout, retry có kiểm
  soát; không chạy import dày đặc. Query theo ID (30 ID) nhẹ hơn query bbox.
- Dữ liệu OSM có thể cũ (nhà hàng đóng cửa, đổi địa chỉ). Vì vậy `verified=false`
  và UI ghi rõ "chưa được xác minh".
- Một số OSM record thiếu `cuisine`, `phone`, `website`, `opening_hours`, hoặc
  địa chỉ chỉ có đường. Không được bịa; hiển thị "Unclassified"/"Not provided".
- `menu_items` không có unique `(menu_id,name)`; phải dùng ID deterministic và
  `skipDuplicates` để tránh nhân bản.
- Cập nhật `osm_tags` bằng `EXCLUDED.osm_tags` sẽ xóa metadata `_bep` ở lần
  import sau; cần merge JSONB (`restaurants.osm_tags || EXCLUDED.osm_tags`).
- Row đã `verified`/`owner_managed` phải bị bỏ qua hoàn toàn (kể cả menu demo).
- Dùng ảnh minh hoạ thay ảnh thật phải được nói rõ; không ghi "ảnh nhà hàng".

### Rủi ro dữ liệu/license

- OSM data: © OpenStreetMap contributors, ODbL 1.0. Cần attribution (đã có ở
  footer) và ghi nguồn trong `osm_tags._bep.sourceUrl`.
- Không dùng Google Images/ảnh không rõ license. Không tải ảnh từ URL không
  kiểm chứng được. Bộ ảnh mới sẽ là SVG minh hoạ do dự án tạo, license rõ ràng.
- Menu/prices là dữ liệu demo, không phải thực đơn chính thức. Phải ghi trong
  DB metadata, API và UI.
- Không tạo rating/review giả. Rating null → UI hiển thị "New".

## 7. Kế hoạch triển khai

### Phase 1 — Mở rộng pipeline (không migration)

- Thêm `cafe` vào danh sách amenity được normalize/query.
- Cho `fetchOsmRestaurants` nhận `query` tuỳ biến (dùng cho query theo ID).
- Merge `osm_tags` khi upsert để không xóa metadata `_bep`.
- Thêm domain thuần `server/domain/hanoi.ts`: 30 OSM ID tuyển chọn, menu profile
  theo cuisine, hàm tạo 10 món/nhà hàng, giá VND, metadata demo/nguồn/license.
- Thêm service `server/services/hanoi-import.service.ts`: fetch theo ID, normalize,
  persist protected upsert, đặt `APPROVED` + `verified=false`, tạo menu demo
  idempotent, ghi job history, dry-run, report.
- Thêm CLI `scripts/import-hanoi.ts` + `npm run import:hanoi`.
- Không sửa generic admin import; nó vẫn tạo PENDING như cũ.

### Phase 2 — Ảnh minh hoạ có license rõ ràng

- Sinh bộ SVG nội bộ: 30 cover duy nhất theo OSM ID + ~24 ảnh món theo nhóm.
- Tên file khớp `imageSchema` (`/images/<lowercase>.svg`), không phụ thuộc mạng.
- Ghi metadata `_bep.image = { type: 'ILLUSTRATION', license: 'Project demo asset' }`.
- UI dùng `onError` fallback.

### Phase 3 — API/frontend

- Không thêm endpoint Catalog trùng lặp. Dùng `GET /restaurants` và
  `GET /restaurants/:id` hiện có; provenance đã có trong response.
- Bổ sung mô tả schema OpenAPI cho các field provenance/metadata.
- Frontend: cuisine chips lấy từ dữ liệu, hiển thị demo banner/source line,
  phone/website/opening hours, nhóm menu theo category, fallback ảnh, giữ
  nguyên cart/checkout.

### Phase 4 — Dữ liệu thật và kiểm chứng

- Chạy dry-run, sau đó import thật 30 nhà hàng Hà Nội từ Overpass.
- Chạy lại lần 2 để chứng minh idempotent.
- So sánh counts trước/sau; xác nhận 3 nhà hàng seed cũ không đổi.
- Test unit/integration/API/E2E; chạy toàn bộ regression.
- Viết `docs/DATA_IMPORT.md`, `docs/DATA_IMPORT_REPORT.md`, cập nhật README.

## 8. Rủi ro dữ liệu và license — quyết định

| Vấn đề              | Quyết định                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| Nguồn nhà hàng      | OpenStreetMap qua Overpass, query theo 30 OSM ID tuyển chọn; không tự tạo địa chỉ/toạ độ               |
| Trạng thái hiển thị | `status='APPROVED'` để demo hiển thị; `verified=false`, `owner_managed=false`; UI ghi rõ chưa xác minh |
| Dữ liệu thiếu       | Giữ NULL/`Unclassified`; không suy diễn                                                                |
| Menu                | Demo 10 món/nhà hàng, giá VND, đánh dấu `_bep.menu.dataType='DEMO'`, `official=false`; UI banner rõ    |
| Ảnh                 | SVG minh hoạ do dự án tạo; không dùng ảnh Google/không rõ license; ghi metadata; fallback khi lỗi      |
| Bảo vệ dữ liệu      | Protected upsert; không xóa; không sửa row verified/owner-managed; ID món deterministic                |
| Migration           | Không cần; dùng JSONB hiện có                                                                          |
| Commit/push         | Không thực hiện                                                                                        |

Điều kiện an toàn để tiếp tục: không sửa baseline, không reset DB, không xóa dữ
liệu, không đổi `.env`/secrets, không commit/push. Các điều kiện này được giữ
trong toàn bộ phần triển khai.
