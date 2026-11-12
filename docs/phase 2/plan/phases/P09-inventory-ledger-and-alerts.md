# P09 Inventory ledger và low-stock alert

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: [P08](P08-restaurant-profile-menus-hours.md), [P05](P05-offer-response-and-core-workflow.md).
- Mục tiêu: Bổ sung ledger cho nguồn stock hiện có và cảnh báo crossing threshold, giữ đúng ngữ nghĩa stock khả dụng không gồm reservation.
- Phạm vi: Không quản nguyên liệu, daily capacity calendar hoặc trừ thêm stock khi giao. Không tự sửa manual available/visible khi stock bằng0.

## Đọc source và điểm sửa

- [server/modules/catalog/infrastructure/menu.repository.ts](../../../../server/modules/catalog/infrastructure/menu.repository.ts)
- [server/modules/catalog/application/catalog.service.ts](../../../../server/modules/catalog/application/catalog.service.ts)
- [server/modules/ordering/application/order-lifecycle.ts](../../../../server/modules/ordering/application/order-lifecycle.ts)
- [server/modules/ordering/application/checkout.ts](../../../../server/modules/ordering/application/checkout.ts)
- [server/seed/seed.ts](../../../../server/seed/seed.ts)
- [server/seed/seed-mock.ts](../../../../server/seed/seed-mock.ts)
- [src/components/Workspace.tsx](../../../../src/components/Workspace.tsx)

File/khu vực mới dự kiến (chưa tồn tại):

- `server/modules/catalog/application/inventory.service.ts`
- `server/modules/catalog/infrastructure/stock-movement.repository.ts`
- `tests/inventory-ledger.test.ts`
- `tests/inventory-concurrency.test.ts`

## Contract và schema

C07. Delta adjustment + legacy stock write adapter, movement API, effective sellable/reason và low-stock crossing notification. Catalog tiếp tục sở hữu stock/reserve/release. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md), [ENGINEERING_RULES](../ENGINEERING_RULES.md).

StockMovement với operation-key uniqueness/index item-time; threshold optional. Mỗi item opening balance tạo đúng một lần dưới item row lock trước mutation hoặc trong backfill dùng cùng lock.

## Tasks và acceptance criteria

### P09-T01

**Opening balance và StockMovement.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Implement ensureOpeningBalance dưới item lock + unique key, ghi số dư hiện tại chứ không dựng history cũ.
- Backfill từng batch khóa row; new create/import/seed path lập opening cho item mới. Lazy ensure trước write bảo vệ concurrent cutover.
- Ledger balanceAfter/delta và timestamp/actor/reason có typed kinds; root fixture raw SQL chỉ dùng test migration, không runtime write bypass.

Acceptance criteria:

- **P09-T01-AC01:** Concurrent opening/backfill/checkout tạo đúng một opening và tổng ledger delta sau cutover bằng stock.
- **P09-T01-AC02:** Stock0 được opening delta0 hợp lệ; không invent pre-cutover reservation/movement history.
- **P09-T01-AC03:** Rerun seed/import/backfill không nhân ledger hoặc ghi đè chỉnh sửa Restaurant.

### P09-T02

**Hợp nhất đường ghi tồn và stock adjustment.** Tiên quyết task: P09-T01.

Thực hiện:

- Reserve/release/adjust/legacy patch đi qua cùng Inventory service/repository trong transaction hiện có.
- Operation keys unique theo order-item-operation và adjustment receipt; new UI dùng delta với reason, legacy absolute target quy đổi dưới lock.
- Kiểm count>=0, all-or-nothing, stock_released guard; failure sau pickup không release.

Acceptance criteria:

- **P09-T02-AC01:** Race checkout cuối suất vs adjustment/release không stock âm hoặc ledger lệch; rollback undo cả stock/movement.
- **P09-T02-AC02:** Replay reserve/release/cancel/expiry không cộng/trừ lần hai; DELIVERED không tạo debit thêm.
- **P09-T02-AC03:** Mọi runtime source path ghi stock có owner service, không hai logic tồn song song.

### P09-T03

**Low-stock alert và effective sellability.** Tiên quyết task: P09-T02.

Thực hiện:

- Computed sellable và unavailableReason kết hợp manual flags/hours/stock, không ghi available=false tự động.
- Low-stock threshold mặc định5, alert một lần khi crossing; restock trên threshold rearm, seed/opening không spam.
- UI ledger/pagination và warning, chỉnh threshold/stock có reason; notification chỉ Restaurant members đúng scope.

Acceptance criteria:

- **P09-T03-AC01:** stock0 chặn đặt và hiển thị sold out; replenish không tự mở món chủ quán đã manual unavailable.
- **P09-T03-AC02:** Repeated updates cùng dải low stock không spam, crossing sau rearm tạo alert mới.
- **P09-T03-AC03:** Foreign Restaurant không xem/đổi ledger, Admin audit view không trở thành quyền sửa tồn.

## Kiểm chứng và exit gate

Opening cutover race, ledger sum invariants, concurrent reserve/adjust/release, old patch compatibility and alert crossing/recipient isolation.

Chạy từ repo root sau khi tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsx --test tests/inventory-ledger.test.ts tests/inventory-concurrency.test.ts tests/architecture.test.ts
npx tsx --test tests/module-boundaries.test.ts
npx tsc --noEmit
npm run db:validate
npm run check:openapi
npm run test:e2e
```

Mỗi AC cần assertion/run thực tế. Checks blocked không tính pass; prerequisite/task chưa DONE thì phase chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility.

## Migration và compatibility

Opening under lock làm barrier per item, không tắt dịch vụ hoặc assume DB không có writes. Không backfill từ mọi order cũ làm trừ lần hai; history có mốc bắt đầu ledger rõ.

## Checkpoint và bàn giao

Ghi cutover progress/items remaining, balance reconciliation query/schema test và runtime stock paths đã hợp nhất. Trước task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất ghi incident/next safe action theo [state protocol](../state/README.md); không bỏ qua AC hoặc chạy phase phụ thuộc.
