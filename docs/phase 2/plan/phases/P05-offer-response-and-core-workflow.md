# P05 Phản hồi offer và nghiệm thu core

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: [P04](P04-assignment-search-and-offers.md).
- Mục tiêu: Hoàn thiện phản hồi offer và recovery, kích hoạt automatic assignment sau khi đủ 12 core acceptance criteria.
- Phạm vi: Có minimal Admin search list/alert và exception guard để đạt core; P07 chỉ nâng cấp monitoring. Không đợi tracking/proof/refund mới kiểm chứng core.

## Đọc source và điểm sửa

- [server/modules/delivery/application/delivery.service.ts](../../../../server/modules/delivery/application/delivery.service.ts)
- [server/modules/ordering/application/order-lifecycle.ts](../../../../server/modules/ordering/application/order-lifecycle.ts)
- [server/modules/notification/notification.service.ts](../../../../server/modules/notification/notification.service.ts)
- [server/jobs.ts](../../../../server/jobs.ts)
- [src/components/Orders.tsx](../../../../src/components/Orders.tsx)
- [src/App.tsx](../../../../src/App.tsx)
- [tests/architecture.test.ts](../../../../tests/architecture.test.ts)
- [tests/browser/flows.spec.ts](../../../../tests/browser/flows.spec.ts)

File/khu vực mới dự kiến (chưa tồn tại):

- `server/modules/assignment/application/offer-response.ts`
- `server/modules/assignment/application/assignment-worker.ts`
- `src/components/DriverOffers.tsx`
- `tests/assignment-offers.test.ts`
- `tests/assignment-concurrency.test.ts`
- `tests/assignment-notifications.test.ts`

## Contract và schema

C01–C05. Atomic accept/reject, durable operational invalidation, deduped notifications và minimal GET /admin/assignments. Old assign là reason/exception-gated alias sau activation; direct self-assign vẫn cấm. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md), [ENGINEERING_RULES](../ENGINEERING_RULES.md).

Shared receipt/notification dedupe nếu chưa có; search/offer/version constraints từ P04. Activation bootstrap chỉ Accepted/Preparing/Ready + UNASSIGNED, idempotent. Thêm milestone arrivedAt nếu chưa có.

## Tasks và acceptance criteria

### P05-T01

**Accept/reject nguyên tử và idempotent.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Triển khai accept lock Order→Delivery→User→Availability→Search/Offer; đọc lại account, fresh location, heartbeat, ready, capacity, expiry và generation.
- Tạo DriverAssignment qua Delivery public capability trong cùng transaction, close offer/search và ghi attempt/history/audit/receipt.
- Reject đòi đúng Driver/reason, finalize attempt và schedule next candidate; duplicate command trả stored result, khác payload conflict.

Acceptance criteria:

- **P05-T01-AC01:** Accept thành công có đúng một confirmed assignment và notification effect; same key/event retry không nhân đôi.
- **P05-T01-AC02:** Expired/offline/inactive/not-ready/stale/busy/cancelled/stale-generation từ chối, không làm partial assignment.
- **P05-T01-AC03:** Driver A không phản hồi offer B; repeated reject không wake vô hạn hoặc ghi attempt mới.

### P05-T02

**Timeout, retry và exhaustion.** Tiên quyết task: P05-T01.

Thực hiện:

- Worker expiry/candidate rotation/backoff theo cap10/round3/deadline10phút, injected DB clock.
- No candidate giữ WAITING giữa vòng, EXHAUSTED khi hết policy, không block Restaurant chuẩn bị món; alert Admin một lần/generation.
- Tách worker errors giữa payment/assignment/notification; reclaim lease và recover pending work sau restart.

Acceptance criteria:

- **P05-T02-AC01:** Reject/timeout/ineligible thử đúng candidate tiếp theo; không mời lại driver đã thử trong generation.
- **P05-T02-AC02:** Clock-advanced tests chứng minh backoff/caps/deadline; no loop retry dày/vô hạn.
- **P05-T02-AC03:** Restart/duplicate ticks không mất search, không double offers hoặc starvation payment maintenance.

### P05-T03

**Notification theo role và offer UI.** Tiên quyết task: P05-T02.

Thực hiện:

- Notification recipient resolver: Customer order/trip status; Restaurant thành viên order mới/assignment/arrival/pickup; Driver offer/assignment/revocation; Admin exhaustion/failure.
- Thêm offer UI/countdown server expiry, trip pickup/dropoff DTO, arrive command và minimal Admin search visibility.
- Sửa staff order refresh theo sự kiện đúng role, fallback poll khi stream unavailable/CONNECTING; dedupe notification bằng business key.

Acceptance criteria:

- **P05-T03-AC01:** Happy path không cần Admin assign; tất cả role nhận đúng notification và không nhận customer PII khi chỉ là candidate.
- **P05-T03-AC02:** Restaurant thấy arrival/pickup, Driver xem chuyến nhận, Customer theo dõi state; arrive không bypass Ready.
- **P05-T03-AC03:** Browser test hết giờ dùng server reject; UI giữ loading/error/retry/keyboard labels và refresh đơn khi actor khác đổi.

### P05-T04

**Invalidation, race tests và core gate.** Tiên quyết task: P05-T03.

Thực hiện:

- Operational invalidation xử lý account/online/ready/GPS/heartbeat change: accept chặn ngay; worker revoke pending offer/search trước pickup theo lock order, tạo incident sau pickup.
- Áp minimal Admin override có reason/exception/idempotency và eligibility; no normal happy-path manual assign; update old tests có chủ đích.
- Kích hoạt default automation sau bootstrap/rehearsal; chạy từng A01–A12 trong COVERAGE_MATRIX và liên kết run assertions.

Acceptance criteria:

- **P05-T04-AC01:** Race hai orders/Driver, accept-vs-expiry/reject/cancel/lock/offline chỉ một outcome hợp lệ với DB thật.
- **P05-T04-AC02:** Pickup Ready guard, cross-role/resource, audit/attempt history và compatibility đều có tests pass.
- **P05-T04-AC03:** A01–A12 đều PASS; bootstrap rerun không tạo search trùng/CONFIRMED search và không thay assignment đã có.
- **P05-T04-AC04:** P05 chưa DONE nếu full relevant regression hoặc minimal Admin observability bị hoãn sang P07.

## Kiểm chứng và exit gate

Offer outcomes, real PostgreSQL race barriers, durable restart/replay, receiver isolation/staff UI, feature activation legacy bootstrap; tất cả core matrix A01–A12.

Chạy từ repo root sau khi tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsx --test tests/assignment-offers.test.ts tests/assignment-concurrency.test.ts tests/assignment-notifications.test.ts
npm test
npm run test:e2e
npx tsc --noEmit
npm run check:openapi
npm run build
```

Mỗi AC cần assertion/run thực tế. Checks blocked không tính pass; prerequisite/task chưa DONE thì phase chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility.

## Migration và compatibility

Không xóa old assign endpoint; tightening body/policy được document và UI/tests chuyển đồng bộ. Flag rollout có rõ false→true; rollback automation vẫn giữ capacity/reason guards và pending search data.

## Checkpoint và bàn giao

Ghi từng A01–A12 evidence, flag/bootstrap status và core cases còn fail. Không gắn M1 nếu chỉ có happy path. Trước task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất ghi incident/next safe action theo [state protocol](../state/README.md); không bỏ qua AC hoặc chạy phase phụ thuộc.
