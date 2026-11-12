# P14 Resilience và nghiệm thu tổng thể

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: [P01](P01-authorization-audit-checkout.md), [P02](P02-driver-capacity-and-history.md), [P03](P03-availability-and-location.md), [P04](P04-assignment-search-and-offers.md), [P05](P05-offer-response-and-core-workflow.md), [P06](P06-realtime-tracking-and-navigation.md), [P07](P07-admin-monitoring-and-reassignment.md), [P08](P08-restaurant-profile-menus-hours.md), [P09](P09-inventory-ledger-and-alerts.md), [P10](P10-delivery-proof.md), [P11](P11-support-review-failure-refund.md), [P12](P12-dashboards-history-earnings.md), [P13](P13-assignment-strategies.md).
- Mục tiêu: Nghiệm thu toàn bộ demo trên source đã thay đổi, gồm recovery, migration legacy và CI thực sự chạy PostgreSQL/Redis/E2E.
- Phạm vi: Không biến local tests thành production SLO. Không mark provider thật/payout/storage production DONE; giữ deferred đã thống nhất.

## Đọc source và điểm sửa

- [server/index.ts](../../../../server/index.ts)
- [server/jobs.ts](../../../../server/jobs.ts)
- [server/modules/location/application/routing.service.ts](../../../../server/modules/location/application/routing.service.ts)
- [server/modules/payment/application/reconcile.ts](../../../../server/modules/payment/application/reconcile.ts)
- [server/modules/notification/infrastructure/redis-bus.ts](../../../../server/modules/notification/infrastructure/redis-bus.ts)
- [.github/workflows/ci.yml](../../../../.github/workflows/ci.yml)
- [scripts/ci-local.sh](../../../../scripts/ci-local.sh)
- [playwright.config.ts](../../../../playwright.config.ts)
- [docs/OPERATIONS.md](../../../../docs/OPERATIONS.md)

File/khu vực mới dự kiến (chưa tồn tại):

- `tests/external-resilience.test.ts`
- `tests/workflow-recovery.test.ts`
- `tests/phase2-migration-rehearsal.test.ts`
- `tests/browser/phase2-workflows.spec.ts`

## Contract và schema

C11; bounded provider breaker/read retries, durable financial recovery, snapshots khi Redis mất. Dùng versioned typed failures và diagnostics không secrets; không thay behavioral acceptance để làm tests xanh. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md), [ENGINEERING_RULES](../ENGINEERING_RULES.md).

Không migration mới chỉ để 'dọn' dữ liệu. Nếu rehearsal phát hiện thiếu constraint/backfill phải tạo migration mới và rerun relevant phase gates; không edit migration applied.

## Tasks và acceptance criteria

### P14-T01

**External resilience và backlog recovery.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Implement per-provider breaker5fail/open30s/one-half-open-probe qua port decorator/injected clock; 4xx validation không trip.
- Bounded read retries theo request budget, no blind financial retry; refund query-before-retry dùng stable ref và nextRun/attempt persisted.
- Backlog health/admin alert và job error isolation; startup/shutdown cleanup streams/Redis/leases có recovery.

Acceptance criteria:

- **P14-T01-AC01:** Deterministic clock/fault tests chứng minh CLOSED/OPEN/HALF_OPEN, reset khi success, concurrent probe không stampede.
- **P14-T01-AC02:** Provider outage không giữ stock/Order/Driver transaction qua network, không double order/assignment/refund.
- **P14-T01-AC03:** Persisted backlog/lastError/nextRun quan sát được; Redis loss fallback hoạt động cả EventSource CONNECTING.

### P14-T02

**CI PostgreSQL/Redis và role E2E.** Tiên quyết task: P14-T01.

Thực hiện:

- CI provision PostgreSQL+Redis test services, pass explicit test URLs/namespaces; fail nếu Redis integration vô tình skip.
- E2E isolated schema, fake deterministic geocoding/routing, browser geolocation/OTP/photo fixtures và traces khi fail.
- Chạy role happy path, rejection/timeout/no-driver, cancellation/reassign/lock races, tracking, proof, support/refund/report flows.

Acceptance criteria:

- **P14-T02-AC01:** CI full typecheck/schema/build/OpenAPI/format/tests/E2E pass trên fresh environment; không dựa dịch vụ local người dùng.
- **P14-T02-AC02:** Có real PostgreSQL race tests và Redis cross-connection tests; full suite timeout hữu hạn và clean resources sau fail.
- **P14-T02-AC03:** E2E không cần Admin trong normal assignment; actor khác nhận realtime/status đúng; browser artifacts được lưu khi fail.

### P14-T03

**Migration rehearsal và đóng coverage.** Tiên quyết task: P14-T02.

Thực hiện:

- Rehearse migrations từ baseline legacy fixture qua từng phase; bao gồm open Driver conflicts, terminal assignments, complaint legacy, proof cutover và inventory opening.
- Map mọi Gxx/Axx sang actual test/run; kiểm đủ AC từng task rồi mới close phase/roadmap M4.
- Cập nhật runbook operations/recovery, limitations/deferred và final HANDOFF với reproducible commands; không tự commit/push.

Acceptance criteria:

- **P14-T03-AC01:** Data counts/order snapshots/history bảo toàn; conflict migration fail-report an toàn, rerun/resume idempotent; không reset/drop application data.
- **P14-T03-AC02:** Mọi Gxx hoặc VERIFIED+evidence hoặc DEFERRED đã chốt; A01–A12 rerun trên code cuối có proof/refund/strategies.
- **P14-T03-AC03:** Full npm test/build/typecheck/OpenAPI/format và E2E có kết quả thực tế; bất kỳ required check blocked thì P14 chưa DONE.
- **P14-T03-AC04:** Runbook nêu rõ demo/local/private storage/simulated money và conditions mở provider thật, không tuyên bố production-ready.

## Kiểm chứng và exit gate

Provider fault/clock breaker, process crash windows, financial uncertainty, Redis disconnect/stream revoke, full role E2E and legacy-to-final migration rehearsal.

Chạy từ repo root sau khi tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsx --test tests/external-resilience.test.ts tests/workflow-recovery.test.ts tests/phase2-migration-rehearsal.test.ts
npm run db:validate
npx tsc --noEmit
npm run build
npm run check:openapi
npm run format:check
npm test
npm run test:e2e
```

Mỗi AC cần assertion/run thực tế. Checks blocked không tính pass; prerequisite/task chưa DONE thì phase chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility.

## Migration và compatibility

Rehearsal trên database/schema throwaway được xác minh target, giữ input fixture legacy và reports. CI chỉ tạo config trong workspace throwaway, không chỉnh .env người dùng. Bất kỳ change sau full pass phải rerun checks liên quan.

## Checkpoint và bàn giao

Nếu hoàn tất ghi code HEAD/diff, all gates/evidence và deferred; nếu không, ghi đúng failing command/incident/nextsafeaction, không mark M4 vì hết context. Trước task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất ghi incident/next safe action theo [state protocol](../state/README.md); không bỏ qua AC hoặc chạy phase phụ thuộc.
