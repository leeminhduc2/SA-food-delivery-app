# P01 Authorization, audit và checkout retry

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: [P00](P00-baseline-and-execution.md).
- Mục tiêu: Áp dụng quyền Admin theo tài liệu, chuẩn hóa audit và sửa khoảng trống checkout idempotency mà không viết lại luồng đặt món.
- Phạm vi: Giữ cancellation window trước acceptance và payment simulator. Không thêm assignment auto hoặc thay shipping formula.

## Đọc source và điểm sửa

- [server/modules/catalog/catalog.routes.ts](../../../../server/modules/catalog/catalog.routes.ts)
- [server/modules/catalog/application/catalog.service.ts](../../../../server/modules/catalog/application/catalog.service.ts)
- [server/modules/backoffice/admin.service.ts](../../../../server/modules/backoffice/admin.service.ts)
- [server/shared/audit.repository.ts](../../../../server/shared/audit.repository.ts)
- [server/modules/ordering/application/checkout.ts](../../../../server/modules/ordering/application/checkout.ts)
- [src/components/Workspace.tsx](../../../../src/components/Workspace.tsx)

File/khu vực mới dự kiến (chưa tồn tại):

- `tests/authorization-policy.test.ts`
- `tests/checkout-idempotency.test.ts`
- `tests/audit-policy.test.ts`

## Contract và schema

C01, C06. Catalog writes chỉ RESTAURANT member; Admin giữ read/approval và suspend riêng có reason. Account status/approval rejection có reason; checkout retry dùng immutable old order address. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md) và [ENGINEERING_RULES](../ENGINEERING_RULES.md).

AuditLog thêm resource_type/outcome/correlation_id nullable và outcome UNKNOWN cho legacy; shared receipt cho command mới nếu cần. Không rewrite legacy audit như đã biết outcome.

## Tasks và acceptance criteria

### P01-T01

**Giới hạn quyền Admin và cập nhật callers.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Tách quyền Catalog write khỏi assertMember đang cho Admin bypass; giữ Admin read qua projection/view policy.
- Thêm command Admin suspend riêng hide/pause với reason và audit; không dùng để sửa tên/ảnh/menu/giá.
- Cập nhật UI, API docs và tests từng caller Admin; bổ sung cross-restaurant create/update/archive bảo vệ.

Acceptance criteria:

- **P01-T01-AC01:** Admin tạo/sửa menu/giá/profile kinh doanh nhận403, kể cả gọi API trực tiếp; Restaurant member vẫn CRUD đúng scope.
- **P01-T01-AC02:** Admin approval/moderation/suspend có reason vẫn hoạt động; không mất read view cần quản trị.
- **P01-T01-AC03:** Existing menu snapshots/orders không bị đổi bởi permission migration.

### P01-T02

**Audit có reason, resource type và outcome.** Tiên quyết task: P01-T01.

Thực hiện:

- Mở rộng audit API typed optional fields tương thích caller cũ; set resourceType/outcome/correlation cho action mới.
- Bắt buộc reason ở account status, approval rejection và sensitive commands triển khai trong phase; transaction gắn audit với business update.
- Test rejected reason không ghi business change, audit không chứa secrets/raw payload nhạy cảm.

Acceptance criteria:

- **P01-T02-AC01:** Account status thiếu reason bị400; có reason thì business+audit cùng commit hoặc rollback.
- **P01-T02-AC02:** Legacy audit đọc được với UNKNOWN/null, không bịa outcome hay mất detail.
- **P01-T02-AC03:** Các action mới có actor/resource/action/time/reason/outcome; no OTP/token/credentials trong audit.

### P01-T03

**Checkout retry trước catalog và routing.** Tiên quyết task: P01-T02.

Thực hiện:

- Tách canonical fingerprint helper và existing-order lookup trước defaultAddress/priceCart/route.
- So request mới với fingerprint legacy bằng old.address; replay không gọi external provider và không reserve stock lại.
- Giữ advisory lock/unique guard lần hai khi tạo key mới, validate price/options/availability như trước.

Acceptance criteria:

- **P01-T03-AC01:** Same key/same payload trả cùng order dù stock hết, restaurant paused, default address đổi/xóa, router lỗi; stock chỉ reserve một lần.
- **P01-T03-AC02:** Same key/payload khác conflict trước provider call; hai request key mới đồng thời không tạo hai order.
- **P01-T03-AC03:** Key mới vẫn từ chối món không bán/giá thay đổi/route không hỗ trợ, không bypass kiểm tra checkout.

## Kiểm chứng và exit gate

Authorization matrix và negative direct HTTP; checkout replay sau thay đổi catalog/address/provider; audit rollback và raw-data redaction.

Chạy từ repo root sau khi đã tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsx --test tests/authorization-policy.test.ts tests/checkout-idempotency.test.ts tests/audit-policy.test.ts
npx tsx --test tests/architecture.test.ts tests/catalog-crud.test.ts
npx tsx --test tests/module-boundaries.test.ts
npx tsc --noEmit
npm run check:openapi
npm run db:validate
```

Mỗi AC phải liên kết assertion/run thực tế. Checks bị chặn không tính pass; không phase DONE nếu task/phase tiên quyết chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility hiện có.

## Migration và compatibility

Additive audit fields; permission tightening có chủ đích phải cập nhật UI/tests/contract. Không đổi format fingerprint cũ mà không dual-read tương thích.

## Checkpoint và bàn giao

Ghi caller Admin đã chuyển/sensitive reason còn chờ phase sau; migration audit status và cases replay đã chứng minh. Trước mỗi task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất, ghi incident và next safe action theo [state protocol](../state/README.md); không tự bỏ qua AC hoặc chạy phase phụ thuộc.
