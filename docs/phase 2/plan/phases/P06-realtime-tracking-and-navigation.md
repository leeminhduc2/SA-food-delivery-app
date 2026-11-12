# P06 Realtime tracking và điều hướng

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: [P05](P05-offer-response-and-core-workflow.md).
- Mục tiêu: Thêm tracking GPS có quyền theo trip và walking navigation, tận dụng Redis/SSE mà không coi Redis là nguồn assignment authoritative.
- Phạm vi: Không lưu trajectory/replay GPS. Driver offline trước assignment vẫn có thể gửi initial location; streaming customer cần assigned trip hiện hành.

## Đọc source và điểm sửa

- [server/modules/location/index.ts](../../../../server/modules/location/index.ts)
- [server/modules/notification/notification.bus.ts](../../../../server/modules/notification/notification.bus.ts)
- [server/modules/notification/notification.stream.ts](../../../../server/modules/notification/notification.stream.ts)
- [server/modules/notification/infrastructure/redis-bus.ts](../../../../server/modules/notification/infrastructure/redis-bus.ts)
- [server/modules/ordering/application/order-queries.ts](../../../../server/modules/ordering/application/order-queries.ts)
- [server/modules/index.ts](../../../../server/modules/index.ts)
- [src/components/DeliveryAddress.tsx](../../../../src/components/DeliveryAddress.tsx)
- [src/App.tsx](../../../../src/App.tsx)

File/khu vực mới dự kiến (chưa tồn tại):

- `server/modules/location/application/driver-tracking.service.ts`
- `server/modules/location/tracking.routes.ts`
- `src/components/DeliveryTracking.tsx`
- `tests/delivery-tracking.test.ts`
- `tests/tracking-stream.test.ts`

## Contract và schema

C04/C05. TrackingAccessGateway do Ordering/composition root cung cấp, Location không import Ordering. Typed tracking topic tái sử dụng Redis lifecycle; notification durable và ephemeral GPS tách message semantics. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md), [ENGINEERING_RULES](../ENGINEERING_RULES.md).

Không trajectory table. Reuse latest DriverLocation, timestamps và proof/assignment version chỉ đọc. Latest Redis TTL120s; DB fallback snapshot vẫn role-authorized.

## Tasks và acceptance criteria

### P06-T01

**Typed Redis transport và snapshot fallback.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Mở rộng transport hiện có bằng typed message topic, lifecycle/connectivity, publish latest-location sau DB commit với TTL.
- Đảm bảo Redis lỗi không rollback GPS snapshot/transaction; read ưu tiên fresh cache đúng version, fallback DB, reject stale cache cũ hơn DB/generation.
- Nối polling/health signal khi EventSource CONNECTING kéo dài; không chờ CLOSED mới fallback.

Acceptance criteria:

- **P06-T01-AC01:** Redis down/reconnect không mất latest DB hoặc làm assignment sai; expired cache không hồi sinh tọa độ cũ.
- **P06-T01-AC02:** Notifications vẫn replay từ inbox như trước, GPS không vào notification outbox hoặc broadcast cho mọi user.
- **P06-T01-AC03:** Cache keys/channels không lẫn schema/test namespace; tests cleanup và timeout hữu hạn.

### P06-T02

**Tracking authorization và SSE lifecycle.** Tiên quyết task: P06-T01.

Thực hiện:

- Implement tracking snapshot/stream auth bằng gateway scope actor/order/current assignment, check account/session trước push.
- Terminal/reassign/lock invalidation đóng stream; heartbeat5s revalidates khi message mất; không chỉ authorize lúc subscribe.
- Cleanup connection limits/timers/disconnect; snapshot fallback không bypass quyền hoặc trả live location sau terminal.

Acceptance criteria:

- **P06-T02-AC01:** Customer/Restaurant/Driver/Admin chỉ xem đúng scope; guessed order/driver ID không rò GPS.
- **P06-T02-AC02:** Đổi assignment trong khi stream đang mở không tiếp tục gửi vị trí Driver cũ; khóa account/expired session thu hồi quyền trong giới hạn5s fallback.
- **P06-T02-AC03:** Terminal location=null; không replay trajectory/old GPS từ Last-Event-ID.

### P06-T03

**Bản đồ, navigation và reconnect UI.** Tiên quyết task: P06-T02.

Thực hiện:

- Map tracking và snapshot fallback cho Customer/Restaurant/Admin; assigned Driver thấy pickup/dropoff route và arrival milestone.
- Gắn nhãn WALKING, capturedAt/stale/disconnected; không trình bày Haversine như route/ETA thật.
- Hook unsubscribe/abort/timer/watch cleanup khi logout/unmount/change order; giữ keyboard/text alternative cho bản đồ.

Acceptance criteria:

- **P06-T03-AC01:** Có UI cho no-driver/no-GPS/stale/provider-error/offline/reconnect, không fake đường/fee/ETA.
- **P06-T03-AC02:** Kiểm browser geolocation và stream outage; không có subscription theo order/actor cũ sau navigation.
- **P06-T03-AC03:** Mobile375/768 và desktop1440 không overflow, thao tác cơ bản dùng keyboard, trạng thái không chỉ dùng màu.

## Kiểm chứng và exit gate

Real Redis transport với DB snapshots, cross-resource authorization khi connection live, revocation race, cache TTL/version, browser map/fallback.

Chạy từ repo root sau khi tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsx --test tests/delivery-tracking.test.ts tests/tracking-stream.test.ts tests/redis-bus.test.ts tests/notification-stream.test.ts
npx tsx --test tests/module-boundaries.test.ts
npx tsc --noEmit
npm run check:openapi
npm run test:e2e
```

Mỗi AC cần assertion/run thực tế. Checks blocked không tính pass; prerequisite/task chưa DONE thì phase chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility.

## Migration và compatibility

Không thêm history GPS để dễ replay. Nêu rõ retention và ảnh hưởng cache namespace; không thay geocoding/address/shipping policy cũ.

## Checkpoint và bàn giao

Ghi transport topics/gateways, permission/revocation cases đã pass, fallback/timeouts và dependency Redis được kiểm thực. Trước task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất ghi incident/next safe action theo [state protocol](../state/README.md); không bỏ qua AC hoặc chạy phase phụ thuộc.
