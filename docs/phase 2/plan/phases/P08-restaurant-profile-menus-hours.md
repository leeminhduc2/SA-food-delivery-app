# P08 Restaurant profile, menu và giờ hoạt động

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: [P01](P01-authorization-audit-checkout.md).
- Mục tiêu: Hoàn thiện hồ sơ Restaurant, nhóm món, giờ phục vụ có cấu trúc và refusal trước acceptance.
- Phạm vi: Không parse opening_hours legacy, không đổi shipping formula/cancellation sau acceptance. Prerequisite tối thiểu P01; mặc định chạy sau P07 để giữ thứ tự plan.

## Đọc source và điểm sửa

- [server/modules/catalog/application/catalog.service.ts](../../../../server/modules/catalog/application/catalog.service.ts)
- [server/modules/catalog/infrastructure/restaurant.repository.ts](../../../../server/modules/catalog/infrastructure/restaurant.repository.ts)
- [server/modules/catalog/infrastructure/menu.repository.ts](../../../../server/modules/catalog/infrastructure/menu.repository.ts)
- [server/modules/ordering/application/order-lifecycle.ts](../../../../server/modules/ordering/application/order-lifecycle.ts)
- [src/components/Workspace.tsx](../../../../src/components/Workspace.tsx)
- [tests/catalog-crud.test.ts](../../../../tests/catalog-crud.test.ts)

File/khu vực mới dự kiến (chưa tồn tại):

- `server/modules/catalog/domain/opening-schedule.ts`
- `tests/restaurant-hours.test.ts`
- `tests/menu-groups.test.ts`
- `tests/restaurant-rejection.test.ts`

## Contract và schema

C06. Phone/schedule/null legacy, timezone Asia/Saigon; Admin chỉ read/approval/suspend. Menu groups unique case-insensitive/restaurant, non-empty delete409. Reject dùng CANCELLED + RESTAURANT_REJECTED. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md), [ENGINEERING_RULES](../ENGINEERING_RULES.md).

Schedule JSON/timezone additive, phone reuse; case-insensitive group uniqueness preflight legacy duplicate names; keep original opening_hours. End interval có thể24:00, chỉ cho end, không start.

## Tasks và acceptance criteria

### P08-T01

**Phone và lịch mở cửa có cấu trúc.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Thêm phone/schedule create/patch/repository/form; validate đủ7day, intervals không overlap, start<end, midnight/overnight nhập tách ngày.
- Pure open-now policy dùng DB now cho quote và reserve transaction; manual pause/hidden/not-approved luôn ưu tiên.
- Null schedule giữ hành vi trước; legacy string display-only; phone không có giữ null.

Acceptance criteria:

- **P08-T01-AC01:** Boundary mở/đóng/midnight/local-day tests, ca qua đêm tách ngày, invalid/overlap trả400.
- **P08-T01-AC02:** Quote trước đóng cửa rồi checkout sau đóng bị RESTAURANT_CLOSED, không tạo partial order/reserve.
- **P08-T01-AC03:** Restaurant tự quản đúng scope; Admin không sửa; legacy schedule-null vẫn đặt như cũ.

### P08-T02

**CRUD nhóm món có ownership.** Tiên quyết task: P08-T01.

Thực hiện:

- Thêm menu group list/create/rename/delete và UI quản lý, normalize name casefold để unique cùng Restaurant.
- Move item qua existing item service; group còn item kể cả archived không xóa.
- Preflight duplicate Foo/foo legacy trước unique index; không tự merge/xóa item; snapshots order không phụ thuộc rename.

Acceptance criteria:

- **P08-T02-AC01:** Cross-restaurant menu writes403; duplicate case-insensitive409; group empty delete được, non-empty409.
- **P08-T02-AC02:** Rename/move không đổi order snapshot/extras và không tạo menu group duplicate khi item CRUD.
- **P08-T02-AC03:** Legacy duplicate fixture dừng migration/report IDs thay vì mất quan hệ item.

### P08-T03

**Restaurant reject và workspace.** Tiên quyết task: P08-T02.

Thực hiện:

- Thêm reject command trong Ordering, reason/key/ownership/status check và tái sử dụng cancellation compensation.
- Restaurant UI phân biệt Reject với Accept; giữ support hướng dẫn sau acceptance.
- Audit và notification Customer/Restaurant; không grant Driver quyền chuẩn bị món.

Acceptance criteria:

- **P08-T03-AC01:** CONFIRMED reject→CANCELLED, release stock và refund pending nếu đã trả; replay không lặp effect.
- **P08-T03-AC02:** Sau ACCEPTED reject bị409; Restaurant khác403; missing reason400.
- **P08-T03-AC03:** Không thêm enum REJECTED hoặc đổi existing cancel behavior âm thầm.

## Kiểm chứng và exit gate

Pure hours policy + HTTP checkout boundaries, phone/schema, menu uniqueness/delete/move, rejection compensation/ownership/idempotency.

Chạy từ repo root sau khi tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsx --test tests/restaurant-hours.test.ts tests/menu-groups.test.ts tests/restaurant-rejection.test.ts tests/catalog-crud.test.ts
npx tsx --test tests/module-boundaries.test.ts
npx tsc --noEmit
npm run check:openapi
npm run test:e2e
```

Mỗi AC cần assertion/run thực tế. Checks blocked không tính pass; prerequisite/task chưa DONE thì phase chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility.

## Migration và compatibility

Additive structured hours, old text giữ; name uniqueness cần preflight, không sửa migration cũ. Nếu P08 được giao trước P05, chỉ dùng notification/compensation hiện có, tích hợp auto workflow ở P05 chịu trách nhiệm.

## Checkpoint và bàn giao

Ghi schedule representation, midnight fixtures, duplicate group preflight và policy reject; không ghi lịch nhập mẫu như lịch thật của toàn bộ nhà hàng. Trước task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất ghi incident/next safe action theo [state protocol](../state/README.md); không bỏ qua AC hoặc chạy phase phụ thuộc.
