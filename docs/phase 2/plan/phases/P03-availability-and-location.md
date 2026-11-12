# P03 Availability và latest GPS

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: [P02](P02-driver-capacity-and-history.md).
- Mục tiêu: Tạo availability operational và latest Driver GPS làm đầu vào cho assignment; không nhầm online với tài khoản active hay GPS còn mới.
- Phạm vi: Module Assignment mới chỉ availability/ports/config ở phase này. GPS được nhận trước assignment để tránh vòng lặp không có vị trí thì không thể được chọn.

## Đọc source và điểm sửa

- [server/modules/identity/index.ts](../../../../server/modules/identity/index.ts)
- [server/modules/location/index.ts](../../../../server/modules/location/index.ts)
- [server/modules/location/address.routes.ts](../../../../server/modules/location/address.routes.ts)
- [server/modules/delivery/index.ts](../../../../server/modules/delivery/index.ts)
- [server/modules/index.ts](../../../../server/modules/index.ts)
- [server/app.ts](../../../../server/app.ts)
- [src/App.tsx](../../../../src/App.tsx)

File/khu vực mới dự kiến (chưa tồn tại):

- `server/modules/assignment/index.ts và assignment.routes.ts`
- `server/modules/assignment/application/availability.service.ts`
- `server/modules/location/application/driver-location.service.ts`
- `src/components/DriverWorkspace.tsx`
- `tests/driver-availability.test.ts`
- `tests/driver-location.test.ts`

## Contract và schema

C02/C04; availability thuộc Assignment, account Identity, location Location, capacity Delivery. Dùng capability port để không tạo Location→Assignment→Location hoặc Delivery→Assignment cycle. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md) và [ENGINEERING_RULES](../ENGINEERING_RULES.md).

DriverAvailability một row/user, DriverLocation một latest row/user, operational change work item; thêm owner maps. Existing Driver mặc định offline/ready=false, không seed vị trí giả.

## Tasks và acceptance criteria

### P03-T01

**Module Assignment và availability.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Tạo public APIs/ports module Assignment, availability routes và config parser defaults từ DECISIONS.
- Triển khai online/ready/heartbeat versioned, busy derive từ Delivery; user/availability lock serialize accept tương lai.
- Online cần fresh GPS và account active; offline busy409; enqueue operational work cho eligibility change, chưa khóa Order ngược chiều.

Acceptance criteria:

- **P03-T01-AC01:** Inactive/foreign-role không sửa availability; busy Driver có thể ready=false nhưng không offline.
- **P03-T01-AC02:** Heartbeat không biến stale GPS thành fresh; stale heartbeat loại eligibility nhưng không xóa assignment.
- **P03-T01-AC03:** Module graph/domain purity/table ownership pass khi thêm models/ports.

### P03-T02

**GPS ingestion và latest location.** Tiên quyết task: P03-T01.

Thực hiện:

- Thêm own-GPS ingestion, validate coordinate/time/rate/monotonic update bằng server/DB time.
- Lưu latest trong DB, public read capability cho ứng viên, không expose raw GPS ở public Catalog/user list.
- Cleanup offline stale records sau15 phút khi không có active trip; tuyệt đối không append trajectory.

Acceptance criteria:

- **P03-T02-AC01:** Active Driver chưa assigned/offline có thể gửi GPS để chuẩn bị online; Customer không giả Driver location.
- **P03-T02-AC02:** Old/future/NaN/out-of-range/out-of-order/too-fast updates bị từ chối đúng code, không làm overwrite vị trí mới.
- **P03-T02-AC03:** Eligibility và cleanup có deterministic clock tests, không sleep90 giây.

### P03-T03

**Driver workspace và GPS lifecycle.** Tiên quyết task: P03-T02.

Thực hiện:

- Tạo Driver workspace online/ready + heartbeat/GPS hook, cleanup khi logout/role change/unmount.
- Đăng ký watchPosition theo tương tác người dùng; gửi khoảng10s với throttle, không fake khi permission denied.
- Hiển thị rõ missing GPS, stale, offline/not-ready và busy; follow-up action để xin quyền/thử lại.

Acceptance criteria:

- **P03-T03-AC01:** Permission denied không chuyển online giả; retry/enable có keyboard labels và error feedback.
- **P03-T03-AC02:** Không rò timer/watch sau logout, không send theo actor cũ; active trip chặn offline có thông báo rõ.
- **P03-T03-AC03:** E2E fake GPS chỉ qua browser test/provider injection, không bật fallbackfake ở runtime.

## Kiểm chứng và exit gate

Backend availability/location validation/time/rate and busy tests; Driver UI permission denied/cleanup/browser geolocation.

Chạy từ repo root sau khi đã tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsx --test tests/driver-availability.test.ts tests/driver-location.test.ts tests/module-boundaries.test.ts
npx tsc --noEmit
npm run check:openapi
npm run test:e2e
```

Mỗi AC phải liên kết assertion/run thực tế. Checks bị chặn không tính pass; không phase DONE nếu task/phase tiên quyết chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility hiện có.

## Migration và compatibility

Additive tables; legacy drivers offline mặc định, không tự online. Vị trí không có là không đủ điều kiện, không dùng địa chỉ tài khoản thay GPS.

## Checkpoint và bàn giao

Ghi config/parser, new owners/ports, browser permission state tested và chưa có auto assignment tới P04. Trước mỗi task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất, ghi incident và next safe action theo [state protocol](../state/README.md); không tự bỏ qua AC hoặc chạy phase phụ thuộc.
