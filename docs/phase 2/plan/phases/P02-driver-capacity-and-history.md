# P02 Driver capacity và lịch sử assignment

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: [P01](P01-authorization-audit-checkout.md).
- Mục tiêu: Bảo vệ capacity một chuyến active/Driver ngay trên luồng hiện có, đồng thời tách history khỏi occupancy.
- Phạm vi: Chưa tự tìm Driver. Gán thủ công vẫn hoạt động P02–P04 nhưng không thể gán Driver đang bận. Không làm mất history khi active đổi nghĩa.

## Đọc source và điểm sửa

- [prisma/schema.prisma](../../../../prisma/schema.prisma)
- [server/modules/delivery/application/delivery.service.ts](../../../../server/modules/delivery/application/delivery.service.ts)
- [server/modules/delivery/infrastructure/delivery.repository.ts](../../../../server/modules/delivery/infrastructure/delivery.repository.ts)
- [server/modules/identity/user.repository.ts](../../../../server/modules/identity/user.repository.ts)
- [server/modules/ordering/infrastructure/order-detail.projection.ts](../../../../server/modules/ordering/infrastructure/order-detail.projection.ts)
- [server/modules/ordering/application/order-queries.ts](../../../../server/modules/ordering/application/order-queries.ts)

File/khu vực mới dự kiến (chưa tồn tại):

- `scripts/preflight-driver-assignments.ts`
- `tests/driver-capacity.test.ts`
- `tests/driver-history.test.ts`

## Contract và schema

C02/C03/C05. Delivery sở hữu confirmed DriverAssignment; Identity public port khóa account. Thêm paginated Driver history, current/final trip DTO và redaction revoked history. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md) và [ENGINEERING_RULES](../ENGINEERING_RULES.md).

ended_at/end_reason và trip milestone timestamps nullable; partial unique driver_assignments(driver_id) WHERE active=true sau preflight/backfill; giữ unique active/delivery. Không tạo Assignment confirmed mới.

## Tasks và acceptance criteria

### P02-T01

**Preflight và backfill assignment legacy.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Viết preflight read-only phân loại terminal active, open multi-active driver, orphan/mismatch assignment-delivery và missing driver.
- Tạo report IDs/counts redacted; backfill chỉ deactivate assignment của terminal Delivery, giữ history/audit migration reason.
- Nếu multi-active open hoặc mismatch chưa giải quyết, dừng migration với report; không chọn trip thắng tự động.

Acceptance criteria:

- **P02-T01-AC01:** Fixture legacy gồm hai open trips cùng Driver làm preflight fail và không tự sửa/xóa trip.
- **P02-T01-AC02:** Terminal assignments được đóng có endedAt/endReason; order/items/payment/history tồn tại nguyên vẹn.
- **P02-T01-AC03:** Preflight rerun idempotent và không ghi credentials/customer address vào report.

### P02-T02

**Constraint một chuyến active và terminal release.** Tiên quyết task: P02-T01.

Thực hiện:

- Identity cung cấp lock account Driver qua public API; assign khóa Order→Delivery→User và kiểm active/busy.
- Thêm unique active-driver index; terminal transitions/cancel đóng assignment cùng transaction với history.
- Same-driver assign hiện hữu xử lý idempotent/no-op hợp lý thay vì tạo lịch sử assignment trùng; reassign chỉ trước pickup.

Acceptance criteria:

- **P02-T02-AC01:** Hai real DB transactions assign hai Order cho một Driver: đúng một thành công, còn lại DRIVER_BUSY/conflict; không hai active rows.
- **P02-T02-AC02:** DELIVERED/FAILED/CANCELLED giải phóng capacity; rollback terminal không giải phóng nhầm.
- **P02-T02-AC03:** Index trực tiếp chặn duplicate active driver ngay cả nếu application guard bị cạnh tranh.

### P02-T03

**History và quyền xem dữ liệu Driver.** Tiên quyết task: P02-T02.

Thực hiện:

- Giữ current/final Driver order access; history endpoint đọc cả closed assignment với DTO theo quyền.
- Reassigned-away chỉ metadata mình, không full current order/dropoff/note/payment/GPS; add restaurant pickup metadata cho assigned trip.
- Cập nhật UI list/history hiện có và tests để terminal close không làm mất chuyến hoàn tất.

Acceptance criteria:

- **P02-T03-AC01:** Driver final xem chuyến hoàn tất của mình; foreign Driver403; revoked Driver không xem live customer PII.
- **P02-T03-AC02:** History pagination ổn định và không phụ thuộc active=true; tests có reassignment→delivery bởi Driver khác.
- **P02-T03-AC03:** Customer/Restaurant/Admin access scope hiện có không bị phá.

## Kiểm chứng và exit gate

PostgreSQL capacity races, migration legacy conflicts, terminal rollback, final-driver vs reassigned-away read authorization và pagination.

Chạy từ repo root sau khi đã tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsx --test tests/driver-capacity.test.ts tests/driver-history.test.ts tests/migration-safety.test.ts
npx tsx --test tests/architecture.test.ts tests/module-boundaries.test.ts
npx tsc --noEmit
npm run check:openapi
```

Mỗi AC phải liên kết assertion/run thực tế. Checks bị chặn không tính pass; không phase DONE nếu task/phase tiên quyết chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility hiện có.

## Migration và compatibility

Preflight phải chạy trước constraint; rehearsal trên schema riêng với legacy fixture. Không tự sửa multi-active open dữ liệu thật. Ghi operator resolution cần thiết thành POLICY/data incident và dừng phụ thuộc.

## Checkpoint và bàn giao

Report conflict và SQL/migration applied status; phân biệt occupancy active với history access; ghi fixtures nào đã rehearsal. Trước mỗi task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất, ghi incident và next safe action theo [state protocol](../state/README.md); không tự bỏ qua AC hoặc chạy phase phụ thuộc.
