# P07 Admin monitoring và reassignment

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: [P06](P06-realtime-tracking-and-navigation.md).
- Mục tiêu: Cung cấp Admin khả năng xem nguyên nhân assignment/delivery và can thiệp trước pickup mà vẫn tuân invariant.
- Phạm vi: Mở rộng minimal monitoring P05, không tạo đường override bỏ eligibility. Sau pickup chỉ incident, không reassign. Failure/refund resolution đầy đủ ở P11.

## Đọc source và điểm sửa

- [server/modules/backoffice/admin.service.ts](../../../../server/modules/backoffice/admin.service.ts)
- [server/modules/backoffice/backoffice.routes.ts](../../../../server/modules/backoffice/backoffice.routes.ts)
- [server/modules/backoffice/report.repository.ts](../../../../server/modules/backoffice/report.repository.ts)
- [server/modules/delivery/application/delivery.service.ts](../../../../server/modules/delivery/application/delivery.service.ts)
- [server/modules/identity/identity.service.ts](../../../../server/modules/identity/identity.service.ts)
- [src/components/Workspace.tsx](../../../../src/components/Workspace.tsx)

File/khu vực mới dự kiến (chưa tồn tại):

- `server/modules/backoffice/assignment-monitoring.projection.ts`
- `src/components/AssignmentMonitoring.tsx`
- `tests/admin-assignment-monitoring.test.ts`
- `tests/admin-reassignment.test.ts`

## Contract và schema

C05: new admin orders/deliveries/assignments paginated; retry generation và reassign reason/exception/idempotency; account lock durable invalidation. Không đổi /orders array. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md), [ENGINEERING_RULES](../ENGINEERING_RULES.md).

Read projection không write cross-module; reuse Incident/Search/Attempt; thêm indices filter nếu explain/query data cần, không dựng nguồn trạng thái thứ hai.

## Tasks và acceptance criteria

### P07-T01

**Monitoring queries, filters và pagination.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Mở filter status/restaurant/driver/time và cursor stable cho order/delivery/search; detail attempts/reasons từ owner capabilities/projections.
- Scope chỉ ADMIN, validate cursor/filter/time bounds, giới hạn limit100 và response trường cần thiết.
- Dùng chỉ số persisted search/status không suy từ notification; ghi error semantics.

Acceptance criteria:

- **P07-T01-AC01:** Pagination không duplicate/mất rows vì tie timestamp, filters theo các field kết hợp đúng.
- **P07-T01-AC02:** Customer/Restaurant/Driver không gọi được admin monitoring; API không lộ OTP/payment secrets/ảnh path.
- **P07-T01-AC03:** /orders cũ vẫn array và lịch sử/role scope không bị thay bởi admin envelope.

### P07-T02

**Attempts, alerts và operational dashboard.** Tiên quyết task: P07-T01.

Thực hiện:

- Admin UI searchable list/detail với search generation, offer outcomes, delay/retry/exhausted reason và live/fallback refresh.
- Chỉ số online/ready/busy tách riêng; pending search vs payment pending không bị gộp.
- Alert lifecycle acknowledgement trên incident/exhaustion, notification dedupe theo business key; không spam mỗi worker tick.

Acceptance criteria:

- **P07-T02-AC01:** No-candidate và timeout/reject được truy nguyên từ timeline, Admin tìm đúng Order/Driver.
- **P07-T02-AC02:** Acknowledged không làm mất history hoặc đổi business state; repeated worker không gửi alert mới cùng generation.
- **P07-T02-AC03:** UI có loading/empty/error/retry, filter form và table/cards dùng được mobile/keyboard.

### P07-T03

**Retry/reassign ngoại lệ và account lock.** Tiên quyết task: P07-T02.

Thực hiện:

- Admin retry chỉ exhausted/operational incident, generation mới; reassign explicit Driver trước pickup qua cùng eligibility/transaction path.
- Lock account hoặc mất heartbeat trước pickup revoke/retry; sau pickup giữ capacity và mở incident chờ P11, không gán Driver mới.
- Audit reason/exception/old-new Driver/outcome; alias assign cũ đi cùng use case, không bypass.

Acceptance criteria:

- **P07-T03-AC01:** Retry/reassign lặp key không sinh history/assignment/generation mới; thiếu reason/exception bị từ chối.
- **P07-T03-AC02:** Reassign-vs-pickup race: pickup thắng thì không reassign, reassign thắng thì old Driver không pickup/đọc private trip.
- **P07-T03-AC03:** Locked/stale Driver đang pickup không bị giải phóng để nhận thêm trip; có incident Admin xử lý rõ.

## Kiểm chứng và exit gate

Filter/cursor/time validation, role isolation, no-driver attempts visibility, override/race/lock, alert dedupe and browser interactions.

Chạy từ repo root sau khi tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsx --test tests/admin-assignment-monitoring.test.ts tests/admin-reassignment.test.ts tests/assignment-concurrency.test.ts
npx tsx --test tests/module-boundaries.test.ts
npx tsc --noEmit
npm run check:openapi
npm run test:e2e
```

Mỗi AC cần assertion/run thực tế. Checks blocked không tính pass; prerequisite/task chưa DONE thì phase chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility.

## Migration và compatibility

Indices additive; nếu thêm alert acknowledgement field không làm reset outbox/history. Không tạo migration 'giải phóng' trip picked-up của Driver locked.

## Checkpoint và bàn giao

Liệt kê exception codes/queries và incident sau pickup chờ P11; ghi legacy assign callers đã cùng policy. Trước task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất ghi incident/next safe action theo [state protocol](../state/README.md); không bỏ qua AC hoặc chạy phase phụ thuộc.
