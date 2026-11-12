# P10 OTP và ảnh minh chứng giao hàng

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: [P05](P05-offer-response-and-core-workflow.md).
- Mục tiêu: Thêm proof OTP hoặc ảnh private và kiểm tra completion mà không khóa các delivery legacy chưa yêu cầu proof.
- Phạm vi: Một phương thức hợp lệ đủ; không AI xác thực nội dung ảnh, không public photo hosting. Storage local một instance cho demo.

## Đọc source và điểm sửa

- [server/modules/delivery/application/delivery.service.ts](../../../../server/modules/delivery/application/delivery.service.ts)
- [server/modules/delivery/infrastructure/delivery.repository.ts](../../../../server/modules/delivery/infrastructure/delivery.repository.ts)
- [server/modules/delivery/delivery.routes.ts](../../../../server/modules/delivery/delivery.routes.ts)
- [server/app.ts](../../../../server/app.ts)
- [src/components/Orders.tsx](../../../../src/components/Orders.tsx)
- [prisma/schema.prisma](../../../../prisma/schema.prisma)

File/khu vực mới dự kiến (chưa tồn tại):

- `server/modules/delivery/application/delivery-proof.service.ts`
- `server/modules/delivery/infrastructure/proof-storage.ts`
- `src/components/DeliveryProof.tsx`
- `tests/delivery-proof-otp.test.ts`
- `tests/delivery-proof-photo.test.ts`

## Contract và schema

C08 và C01. Customer tạo OTP, Driver chỉ verify; raw binary photo + X-Idempotency-Key tránh multipart dependency. Proof/assignment/access qua Delivery-owned ports; không bypass current assignment. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md), [ENGINEERING_RULES](../ENGINEERING_RULES.md).

Challenge/proof records, salt/hash/attempts/expires/status/storage metadata; proofRequired default false cho existing DB rows, createDelivery mới snapshot config true khi P10 active.

## Tasks và acceptance criteria

### P10-T01

**OTP challenge và verification.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Tạo Customer-owned OTP challenge trong PICKED_UP/IN_TRANSIT, random6digits, scrypt/hash+salt, TTL10phút/max5 và rate3challenge/10phút.
- Response lần tạo có plaintext, receipt/replay không giữ plaintext; UI giải thích otp:null cần regenerate key mới, revoke challenge cũ.
- Verify giữ receipt/outcome và failed attempt commit ngay cả response lỗi: không throw rollback count trong transaction.

Acceptance criteria:

- **P10-T01-AC01:** Driver/Restaurant/Admin không đọc plaintext OTP qua challenge/order/notification/log; foreign Customer403.
- **P10-T01-AC02:** Invalid attempts tăng đúng một lần/key; hết5 khóa challenge; expiry/regenerate/old assignment không verify được.
- **P10-T01-AC03:** OTP correct+retry idempotent; race regenerate-vs-verify không dùng challenge đã revoke.

### P10-T02

**Private photo storage và authorization.** Tiên quyết task: P10-T01.

Thực hiện:

- ProofStorage port local private random filenames, binary body cap5MB MIME+magic validation; không path input/static exposure.
- Gắn file/proof vào current assignment, staged commit/orphan cleanup; content endpoint auth trên resource mỗi lần.
- Retention30 ngày sau terminal, hold khi complaint/incident mở; giữ metadata/audit khi purge. Trước P11 chưa có Complaint hold extension thì dùng existing complaint query qua gateway.

Acceptance criteria:

- **P10-T02-AC01:** JPEG/PNG đúng được đọc qua auth, oversized/wrong-signature/path traversal bị reject, không trả private filesystem path.
- **P10-T02-AC02:** DB failure sau upload không để orphan lâu dài hoặc proof VERIFIED trỏ file thiếu; delete/cleanup retry có evidence.
- **P10-T02-AC03:** Foreign role/resource và reassigned-away không đọc ảnh private của trip người khác; test hold/purge deterministic clock.

### P10-T03

**Proof requirement và completion UI.** Tiên quyết task: P10-T02.

Thực hiện:

- DELIVERED transition kiểm proofRequired snapshot và một VERIFIED proof của current assignment; không buộc cả2 phương thức.
- Thêm Customer challenge UI, Driver OTP/photo form/error/retry và optimistic-safe completion.
- Cập nhật E2E/new fixtures tạo proof; legacy delivery không retroactively bắt proof; config đổi không đổi snapshot trip đang có.

Acceptance criteria:

- **P10-T03-AC01:** New delivery thiếu proof409PROOF_REQUIRED; OTP hoặc photo verified riêng lẻ đều complete được.
- **P10-T03-AC02:** Legacy proofRequired=false hoàn tất theo luồng cũ; terminal retry không nhân history/earning/notification.
- **P10-T03-AC03:** Proof UI có labels/loading/focus/error, không log OTP hay persist plaintext ngoài state hiển thị tạm.

## Kiểm chứng và exit gate

OTP attempt/rate/expiry/replay races, raw photo signature/size/auth/storage rollback/cleanup, legacy/new completion gate và browser OTP/photo.

Chạy từ repo root sau khi tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsx --test tests/delivery-proof-otp.test.ts tests/delivery-proof-photo.test.ts tests/architecture.test.ts
npx tsx --test tests/module-boundaries.test.ts
npx tsc --noEmit
npm run check:openapi
npm run test:e2e
```

Mỗi AC cần assertion/run thực tế. Checks blocked không tính pass; prerequisite/task chưa DONE thì phase chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility.

## Migration và compatibility

Additive proof fields; legacy default false. Snapshot true trong application createDelivery mới, không global timestamp rule áp ngược. .data gitignored và ngoài static; external storage deferred.

## Checkpoint và bàn giao

Ghi cutover/proof snapshot, challenge privacy/replay exception, storage cleanup/retention evidence và file staging còn pending. Trước task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất ghi incident/next safe action theo [state protocol](../state/README.md); không bỏ qua AC hoặc chạy phase phụ thuộc.
