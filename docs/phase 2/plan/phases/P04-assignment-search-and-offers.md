# P04 Quá trình tìm Driver và tạo offer

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: [P03](P03-availability-and-location.md).
- Mục tiêu: Nối Accepted với durable tìm Driver và offer đầu tiên thông qua strategy và worker, giữ transaction ngắn.
- Phạm vi: Chưa kích hoạt automation mặc định hoặc coi core xong trước P05. Feature flag false mặc định, có integration tests chạy true.

## Đọc source và điểm sửa

- [server/shared/events.ts](../../../../server/shared/events.ts)
- [server/modules/index.ts](../../../../server/modules/index.ts)
- [server/modules/ordering/application/order-lifecycle.ts](../../../../server/modules/ordering/application/order-lifecycle.ts)
- [server/modules/ordering/ordering.handlers.ts](../../../../server/modules/ordering/ordering.handlers.ts)
- [server/jobs.ts](../../../../server/jobs.ts)
- [server/modules/delivery/delivery.ports.ts](../../../../server/modules/delivery/delivery.ports.ts)
- [tests/module-boundaries.test.ts](../../../../tests/module-boundaries.test.ts)

File/khu vực mới dự kiến (chưa tồn tại):

- `server/modules/assignment/domain/assignment-status.ts`
- `server/modules/assignment/domain/assignment-strategy.ts`
- `server/modules/assignment/application/search.service.ts`
- `server/modules/assignment/infrastructure/assignment.repository.ts`
- `tests/assignment-workflow.test.ts`
- `tests/assignment-strategy.test.ts`

## Contract và schema

C02/C03/C04/C10. Ordering cung cấp order eligibility/pickup gateway, Assignment rank interface dùng Location/Delivery capabilities. OrderAccepted handler cùng transaction chỉ persist search, không map call. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md) và [ENGINEERING_RULES](../ENGINEERING_RULES.md).

Search/Offer/Attempt và partial unique OFFERED driver/search, unique live search/delivery/generation, lease/due/version indices. Confirmed DriverAssignment giữ Delivery ownership.

## Tasks và acceptance criteria

### P04-T01

**Search, offer, attempt và durable work.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Tạo pure state policies và repository typed cho search/offer/attempt theo C03, migration constraints/test trực tiếp.
- Thêm claim lease/due/version, worker crash reclaim, operation dedupe cho Accepted generation đầu.
- Attempt ghi cả candidate INELIGIBLE hoặc offer outcome, không overwrite lịch sử lần thử khác.

Acceptance criteria:

- **P04-T01-AC01:** DB chặn hai live search/delivery hoặc OFFERED cùng Driver/search; repeated event không tạo generation mới.
- **P04-T01-AC02:** Worker chết lease hết hạn được reclaim; worker cũ không commit stale result sau version đổi.
- **P04-T01-AC03:** Search terminal/offer state transitions bị reject đúng, history không bị sửa sai.

### P04-T02

**Strategy contract và Nearest Driver.** Tiên quyết task: P04-T01.

Thực hiện:

- Tạo AssignmentStrategy rank contract và Nearest pure implementation, injectable policies/clock.
- Candidate query lọc account/availability/heartbeat/GPS/capacity/radius và exclude attempted; stable distance/ID order.
- Đặt metadata criterion rõ Haversine; không dùng ranking distance vào phí/route UI.

Acceptance criteria:

- **P04-T02-AC01:** Fixtures nearest/tie/bounds/no-candidate ra kết quả xác định, không mutate list hoặc assign trong rank.
- **P04-T02-AC02:** Stale/not-ready/inactive/busy/foreign region bị loại; chỉ cấp capability tối thiểu.
- **P04-T02-AC03:** Thêm fake strategy chạy cùng contract tests mà không sửa search lifecycle/controller.

### P04-T03

**OrderAccepted và worker tạo offer.** Tiên quyết task: P04-T02.

Thực hiện:

- Ordering publish OrderAccepted khi transition commit; register handler tại composition root để insert durable search atomic.
- Worker đọc pickup/candidates và rank ngoài lock, revalidate under lock trước create offer/attempt/notification.
- Feature flag true chỉ trong tests; Accepted rollback, duplicate publish và restart đều có behavior evidence.

Acceptance criteria:

- **P04-T03-AC01:** Accepted rollback không để orphan search; duplicate event chỉ một workflow business.
- **P04-T03-AC02:** Sau Accepted commit rồi process dừng, worker mới vẫn tạo offer; không phụ thuộc JS memory queue.
- **P04-T03-AC03:** Không giữ stock/order/driver row lock qua map/network; offer chỉ gửi đúng Driver với privacy DTO.

## Kiểm chứng và exit gate

State machine/strategy tests, direct constraint tests, Accepted rollback/restart/duplicate, lease competing workers and minimal offer privacy.

Chạy từ repo root sau khi đã tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsx --test tests/assignment-workflow.test.ts tests/assignment-strategy.test.ts tests/module-boundaries.test.ts
npx tsc --noEmit
npm run db:validate
npm run check:openapi
```

Mỗi AC phải liên kết assertion/run thực tế. Checks bị chặn không tính pass; không phase DONE nếu task/phase tiên quyết chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility hiện có.

## Migration và compatibility

Additive schema với indices; không auto tạo search cho CONFIRMED hoặc chuyển đổi toàn bộ legacy order. Bootstrap Accepted unassigned chỉ khi P05 activation.

## Checkpoint và bàn giao

Ghi flag state, handler registration, search lease/recovery behavior và P05 phản hồi/expiry còn chưa nghiệm thu. Trước mỗi task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất, ghi incident và next safe action theo [state protocol](../state/README.md); không tự bỏ qua AC hoặc chạy phase phụ thuộc.
