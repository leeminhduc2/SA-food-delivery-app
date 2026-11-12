# P12 Dashboard, history và earning estimate

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: [P07](P07-admin-monitoring-and-reassignment.md), [P09](P09-inventory-ledger-and-alerts.md), [P11](P11-support-review-failure-refund.md).
- Mục tiêu: Cung cấp dashboard/history/earning đáng tin về định nghĩa chỉ số, phạm vi quyền và dữ liệu legacy thiếu mốc.
- Phạm vi: Không payout/settlement thật. Giữ legacy revenue là gross delivered order value bao gồm ship, không đổi nghĩa field cũ.

## Đọc source và điểm sửa

- [server/modules/backoffice/report.service.ts](../../../../server/modules/backoffice/report.service.ts)
- [server/modules/backoffice/report.repository.ts](../../../../server/modules/backoffice/report.repository.ts)
- [server/modules/ordering/infrastructure/order-detail.projection.ts](../../../../server/modules/ordering/infrastructure/order-detail.projection.ts)
- [server/modules/delivery/index.ts](../../../../server/modules/delivery/index.ts)
- [src/components/Workspace.tsx](../../../../src/components/Workspace.tsx)
- [src/App.tsx](../../../../src/App.tsx)
- [prisma/schema.prisma](../../../../prisma/schema.prisma)

File/khu vực mới dự kiến (chưa tồn tại):

- `server/modules/delivery/application/driver-report.service.ts`
- `server/modules/delivery/infrastructure/earning.repository.ts`
- `src/components/DriverHistory.tsx`
- `src/components/RestaurantDashboard.tsx`
- `tests/report-metrics.test.ts`
- `tests/driver-earnings.test.ts`

## Contract và schema

C05/C10. Paginated driver history/current DTO, report from/to UTC [from,to), UI Asia/Saigon; basis/coverage/null cho dữ liệu thiếu, no fake net/payout. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md), [ENGINEERING_RULES](../ENGINEERING_RULES.md).

DriverEarningEstimate unique/delivery thuộc Delivery, amount=Order.delivery_fee qua owner gateway snapshot; business timestamps nullable legacy. Index time/driver/report theo workload.

## Tasks và acceptance criteria

### P12-T01

**Restaurant metrics có định nghĩa rõ.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Tách merchandise/gross ship-inclusive/refunded metrics với cohort/time basis rõ; giữ alias revenue cũ.
- Tính prep/waiting/delivery durations từ milestone/history đúng, không lấy createdAt thay thiếu mốc; trả coverage counts.
- Restaurant scoped theo membership, dashboard inventory/low-stock từ owner API/projection read-only.

Acceptance criteria:

- **P12-T01-AC01:** Fixtures nhiều trạng thái/refund/timezone chứng minh số liệu đúng định nghĩa; không trừ refund khác cohort thành net.
- **P12-T01-AC02:** Missing timestamps trả null/coverage, zero denominator không NaN/Infinity; legacy revenue nghĩa cũ.
- **P12-T01-AC03:** Restaurant không xem metric nhà hàng khác, Admin giữ global scope đúng.

### P12-T02

**Driver history, performance và earning.** Tiên quyết task: P12-T01.

Thực hiện:

- Earning estimate creation idempotent trên DeliveryCompleted trong transaction qua fee snapshot gateway; một estimate/delivery final Driver.
- Backfill legacy chỉ khi final Driver/fee/deliveredAt xác định, thiếu thì report count unresolved không bịa.
- Driver history/performance/estimate UI, filter/pagination; redacted assignment-revoked metadata theo P02.

Acceptance criteria:

- **P12-T02-AC01:** Delivered có đúng một estimate100% fee snapshot; duplicate event không nhân, failed/cancelled không có.
- **P12-T02-AC02:** Sửa current fee/menu hoặc refund khách không đổi estimate; UI ghi rõ ước tính/chưa phải payout.
- **P12-T02-AC03:** Old Driver bị reassign không đọc earning final Driver/dropoff PII; backfill idempotent, missing data có coverage.

### P12-T03

**Admin KPI và time filters.** Tiên quyết task: P12-T02.

Thực hiện:

- Admin operational KPIs orders by state/online/ready/searching/in-transit/success-failure/actual duration, explain basis.
- Time range validation/UTC conversion và stable filtered pagination; cùng definitions dùng chung pure metric helpers nếu cần.
- UI accessible charts/tables có text/legend, loading/empty/error và refresh phù hợp, không dùng màu làm thông tin duy nhất.

Acceptance criteria:

- **P12-T03-AC01:** Online/ready/busy/searching phân biệt đúng, không đếm notification làm status; success rate đúng terminal cohort.
- **P12-T03-AC02:** Time tests qua00:00 Asia/Saigon/from inclusive/to exclusive pass.
- **P12-T03-AC03:** Scope/filter/zero/null UI không hiển thị số liệu giả hoặc label payout.

## Kiểm chứng và exit gate

Financial metric cohorts/snapshots/estimates, idempotent backfill, missing timestamps, local-day boundary and role-scoped dashboard/browser.

Chạy từ repo root sau khi tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsx --test tests/report-metrics.test.ts tests/driver-earnings.test.ts tests/driver-history.test.ts
npx tsx --test tests/module-boundaries.test.ts
npx tsc --noEmit
npm run check:openapi
npm run test:e2e
```

Mỗi AC cần assertion/run thực tế. Checks blocked không tính pass; prerequisite/task chưa DONE thì phase chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility.

## Migration và compatibility

Additive estimate/time indices; không sửa giá/fee order cũ; backfill phải có coverage report và stable business key. Không gọi gross là tiền Restaurant thực nhận.

## Checkpoint và bàn giao

Ghi metric formulas/cohorts, estimate/backfill counts và coverage missing; nêu rõ refund không clawback estimate theo D07. Trước task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất ghi incident/next safe action theo [state protocol](../state/README.md); không bỏ qua AC hoặc chạy phase phụ thuộc.
