# P00 Baseline và quy trình thực thi

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: Không.
- Mục tiêu: Thiết lập baseline có thể tái hiện, môi trường test cô lập và quy trình evidence trước khi sửa nghiệp vụ.
- Phạm vi: Không triển khai assignment/GPS/refund ở phase này. Việc các file plan đã tồn tại chỉ là scaffold, không chứng minh task P00 hoàn thành.

## Đọc source và điểm sửa

- [package.json](../../../../package.json)
- [tests/architecture.test.ts](../../../../tests/architecture.test.ts)
- [tests/redis-bus.test.ts](../../../../tests/redis-bus.test.ts)
- [tests/migration-safety.test.ts](../../../../tests/migration-safety.test.ts)
- [scripts/ci-local.sh](../../../../scripts/ci-local.sh)
- [.github/workflows/ci.yml](../../../../.github/workflows/ci.yml)
- [server/migrate.ts](../../../../server/migrate.ts)
- [docs/OPERATIONS.md](../../../../docs/OPERATIONS.md)

Khu vực bổ sung dự kiến:

- `test environment helpers nếu cần, giữ trong tests/`
- Cập nhật hướng dẫn test isolation trong `docs/OPERATIONS.md` hiện có.

## Contract và schema

Không đổi business API/schema. Xác minh command/path thực tế trước mọi check. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md) và [ENGINEERING_RULES](../ENGINEERING_RULES.md).

Không migration ứng dụng. Mỗi integration run tạo schema test ngẫu nhiên, pg search_path và Prisma schema phải cùng target.

## Tasks và acceptance criteria

### P00-T01

**Xác minh baseline và giới hạn môi trường.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Ghi branch/HEAD/status, user diff và baseline source; so với audit để nhận diện drift.
- Chạy typecheck, boundary/SSE tests và OpenAPI; kiểm health PostgreSQL/Redis có timeout, chỉ log host/port/error redacted.
- Ghi run với checks pass/fail/blocked thực tế; không lấy historical audit làm baseline mới.

Acceptance criteria:

- **P00-T01-AC01:** Run có branch/HEAD, changed paths, versions/runtime và kết quả từng lệnh đã chạy.
- **P00-T01-AC02:** Dependency không có được phân loại ENVIRONMENT, không kết luận business assertions fail/pass; không in .env hoặc credential.

### P00-T02

**Test isolation, timeout và cleanup.** Tiên quyết task: P00-T01.

Thực hiện:

- Chuẩn hóa helpers tạo và cleanup schema test, xác nhận target sau connect trước migrate; chỉ xóa đúng schema của run.
- Redis integration dùng namespace test riêng, finally cleanup và timeout hữu hạn, disconnect cả khi publish/assert fail.
- Dùng process env/DOTENV_CONFIG_PATH cho test thay vì sửa .env người dùng; cập nhật CI/local runner để có cấu hình test rõ.

Acceptance criteria:

- **P00-T02-AC01:** Hai test runs không đọc/ghi schema nhau hoặc schema ứng dụng; test migration cleanup đúng target.
- **P00-T02-AC02:** Redis unavailable kết thúc trong <=10s với fail/blocked rõ, không reconnect giữ tiến trình vô hạn.
- **P00-T02-AC03:** Nếu có đủ dependencies: targeted DB/Redis checks pass; nếu thiếu, task BLOCKED chứ không DONE bằng static review.

### P00-T03

**Registry, traceability và checkpoint ban đầu.** Tiên quyết task: P00-T02.

Thực hiện:

- Đối chiếu đủ mọi gap/core AC trong COVERAGE_MATRIX với task registry thực tế.
- Cập nhật STATUS/HANDOFF với baseline và next safe action; giữ NOT_STARTED cho task chưa code.
- Kiểm link, task IDs, dependency và loại dữ liệu được phép ghi trong run/incident.

Acceptance criteria:

- **P00-T03-AC01:** Không orphan gap hoặc missing task; P05 core A01–A12 có owner.
- **P00-T03-AC02:** Checkpoint có thể dùng tiếp mà không đọc transcript; không đánh dấu P00 DONE nếu T01/T02 còn blocked.

## Kiểm chứng và exit gate

Existing static/integration checks; có thể thêm tests cho shared test helper khi cần bảo vệ target schema, không viết test chỉ kiểm nội dung Markdown.

Chạy từ repo root sau khi đã tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsc --noEmit
npx tsx --test tests/module-boundaries.test.ts tests/notification-stream.test.ts
npm run check:openapi
npx tsx --test tests/migration-safety.test.ts tests/redis-bus.test.ts
```

Mỗi AC phải liên kết assertion/run thực tế. Checks bị chặn không tính pass; không phase DONE nếu task/phase tiên quyết chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility hiện có.

## Migration và compatibility

Không chạy npm run db:migrate vào database người dùng. Không chạy scripts/ci-local.sh mù: đọc side effects trước, đặc biệt .env/container cleanup.

## Checkpoint và bàn giao

Ghi dependency thực tế và lệnh tối thiểu để tiếp tục; nếu thiếu Docker/DB/Redis, incident chỉ rõ điều kiện unblock. Trước mỗi task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất, ghi incident và next safe action theo [state protocol](../state/README.md); không tự bỏ qua AC hoặc chạy phase phụ thuộc.
