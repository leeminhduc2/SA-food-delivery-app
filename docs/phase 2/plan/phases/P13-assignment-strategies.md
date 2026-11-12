# P13 Lowest ETA và Balanced Load

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: [P06](P06-realtime-tracking-and-navigation.md), [P12](P12-dashboards-history-earnings.md).
- Mục tiêu: Bổ sung Lowest ETA và Balanced Load qua cùng strategy port, không làm đổi assignment workflow/invariant.
- Phạm vi: Nearest vẫn default. ETA là walking trong tập top5 nearest, không tuyên bố fastest global/motorbike. Balanced Load dùng công việc24h, không active count của các Driver rảnh.

## Đọc source và điểm sửa

- [server/modules/location/application/routing.service.ts](../../../../server/modules/location/application/routing.service.ts)
- [server/modules/location/infrastructure/routing.client.ts](../../../../server/modules/location/infrastructure/routing.client.ts)
- [server/modules/delivery/index.ts](../../../../server/modules/delivery/index.ts)
- [server/modules/index.ts](../../../../server/modules/index.ts)
- [tests/module-boundaries.test.ts](../../../../tests/module-boundaries.test.ts)

File/khu vực mới dự kiến (chưa tồn tại):

- `server/modules/assignment/application/strategies/lowest-eta.strategy.ts`
- `server/modules/assignment/application/strategies/balanced-load.strategy.ts`
- `tests/assignment-strategy-contract.test.ts`
- `tests/assignment-advanced-strategies.test.ts`

## Contract và schema

C10. rank trả permutation toàn bộ eligible input, không drop/add/duplicate/write candidate; shared typed criterion/routeMode/fallbackReason/rankingScope. Strategy không trực tiếp check/claim Driver thay application policy. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md), [ENGINEERING_RULES](../ENGINEERING_RULES.md).

Không schema algorithm song song. Ghi strategy/criterion/selection scope/fallback vào Search/Attempt metadata đã có; Delivery cung cấp pickup count24h qua public query.

## Tasks và acceptance criteria

### P13-T01

**Lowest ETA và fallback có nhãn.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Lấy top5 nearest, route estimate qua injected Location port ngoài transaction; fully routed top5 sắp ETA rồi distance/ID.
- Nối phần candidate ngoài top5 theo Nearest ở cuối với route ETA null và scope TOP5_NEAREST; nếu bất kỳ top5 route lỗi/thiếu fallback toàn bộ Nearest có reason.
- Giữ timeout/concurrency/cache adapter và labels WALKING, không ETA0 cho unknown.

Acceptance criteria:

- **P13-T01-AC01:** All-routed fixtures rank ETA đúng trong top5; tail giữ đủ IDs nhưng không có ETA giả.
- **P13-T01-AC02:** Partial timeout/no-route/provider failure fallback Nearest deterministic và có metadata.
- **P13-T01-AC03:** Không external call dưới Order/Driver lock; không sửa fees/customer shipping formula.

### P13-T02

**Balanced Load trong cửa sổ 24 giờ.** Tiên quyết task: P13-T01.

Thực hiện:

- Delivery owner query số delivery đã pickup trong rolling24h, gắn actual Driver, kể cả failed sau pickup; exclude cancel trước pickup.
- Rank ascending count rồi Haversine rồi Driver ID; DB now/clock truyền context nhất quán.
- Không query bảng module khác trực tiếp từ Assignment strategy/domain.

Acceptance criteria:

- **P13-T02-AC01:** Fixtures Driver cùng0active nhưng số pickup khác nhau cho thứ tự cân bằng đúng.
- **P13-T02-AC02:** 24h boundary inclusive/exclusive cố định [now-24h,now], history duplicate không double count một delivery.
- **P13-T02-AC03:** Count missing legacy không bịa thành observed0: metadata coverage/fallback Nearest nếu thiếu count cần thiết.

### P13-T03

**Strategy configuration và contract tests.** Tiên quyết task: P13-T02.

Thực hiện:

- Config registry chọn NEAREST/LOWEST_ETA/BALANCED_LOAD, invalid value fail startup; không switch trong controller.
- Contract suite chạy cả3 strategies và fake: IDs permutation, deterministic tie, immutable input, typed fallback, không side effects.
- End-to-end workflow tests mỗi strategy vẫn enforce eligibility/atomic accept/one-active và audit metadata.

Acceptance criteria:

- **P13-T03-AC01:** Đổi config không sửa route/controller/state machine; Nearest vẫn default.
- **P13-T03-AC02:** Cùng input+clock+provider result cho cùng ranking, contract violation bị test phát hiện.
- **P13-T03-AC03:** Race/concurrency và resource authorization pass với cả3 strategies.

## Kiểm chứng và exit gate

Common substitutability suite, top5 ETA/tail/fallback, pickup-load history window/count coverage và workflow invariants across strategy config.

Chạy từ repo root sau khi tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsx --test tests/assignment-strategy-contract.test.ts tests/assignment-advanced-strategies.test.ts tests/assignment-concurrency.test.ts
npx tsx --test tests/module-boundaries.test.ts
npx tsc --noEmit
npm run check:openapi
```

Mỗi AC cần assertion/run thực tế. Checks blocked không tính pass; prerequisite/task chưa DONE thì phase chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility.

## Migration và compatibility

Không đổi default strategy hoặc pricing/data snapshots khi thêm algorithms. Metadata additive; invalid config không silent fallback, provider failure fallback phải được ghi rõ.

## Checkpoint và bàn giao

Ghi strategy scope/tie rules, contract evidence, provider-budget/defaultconfig và metric coverage fallback. Trước task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất ghi incident/next safe action theo [state protocol](../state/README.md); không bỏ qua AC hoặc chạy phase phụ thuộc.
