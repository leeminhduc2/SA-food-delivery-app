# P11 Support, review và failure/refund

- Trạng thái ban đầu: NOT_STARTED.
- Phase tiên quyết: [P07](P07-admin-monitoring-and-reassignment.md), [P10](P10-delivery-proof.md).
- Mục tiêu: Hoàn thiện support/review và failure resolution với full-refund approval, simulator execution và recovery bền vững.
- Phạm vi: Không partial refund/redelivery sau pickup/provider thật. DeliveryIncident trong DB là nghiệp vụ ứng dụng; state/incidents Markdown là lỗi triển khai, không trộn hai loại.

## Đọc source và điểm sửa

- [server/modules/support/support.service.ts](../../../../server/modules/support/support.service.ts)
- [server/modules/support/complaint.repository.ts](../../../../server/modules/support/complaint.repository.ts)
- [server/modules/review/review.service.ts](../../../../server/modules/review/review.service.ts)
- [server/modules/payment/application/reconcile.ts](../../../../server/modules/payment/application/reconcile.ts)
- [server/modules/payment/application/payment-lifecycle.ts](../../../../server/modules/payment/application/payment-lifecycle.ts)
- [server/modules/payment/infrastructure/payment-provider.ts](../../../../server/modules/payment/infrastructure/payment-provider.ts)
- [server/modules/backoffice/backoffice.routes.ts](../../../../server/modules/backoffice/backoffice.routes.ts)
- [src/components/Workspace.tsx](../../../../src/components/Workspace.tsx)

File/khu vực mới dự kiến (chưa tồn tại):

- `server/modules/review/application/review-response.service.ts`
- `server/modules/delivery/application/incident.service.ts`
- `server/modules/payment/application/refund.service.ts`
- `src/components/RefundRequests.tsx`
- `tests/support-role-workflows.test.ts`
- `tests/delivery-incidents.test.ts`
- `tests/refund-workflow.test.ts`

## Contract và schema

C09. Reporter scope đa role, reply/moderation history, failure incident→Admin approve/reject full refund. Không đổi Order DELIVERED hoặc Driver estimate do refund. Cancellation/late success giữ auto-refund, dùng cùng stable operation/reference. Đọc [CONTRACTS](../CONTRACTS.md), [DECISIONS](../DECISIONS.md), [ENGINEERING_RULES](../ENGINEERING_RULES.md).

Complaint reporter fields backfill, customer_id legacy giữ cho Customer và nullable cho non-Customer mới; update mọi reader/notifier dùng reporterId fallback legacy trước enable staff submissions. Reply/revisions/moderation; incident resolution; RefundRequest + due/attempt/history và receipt constraints.

## Tasks và acceptance criteria

### P11-T01

**Complaint đa role và review response.** Tiên quyết task: mọi phase tiên quyết đã DONE.

Thực hiện:

- Mở complaint create/list cho đúng reporter CUSTOMER/RESTAURANT/DRIVER; migrate reporterId/role, DTO không mở thêm PII cho revoked Driver.
- Review reply/version history của Restaurant member; moderation request/decision có reason/evidence, original review giữ nguyên.
- UI role-support, Restaurant replies và Admin queue; resolution notify reporter thực tế, không giả Restaurant là customer.

Acceptance criteria:

- **P11-T01-AC01:** Ownership matrix cho mọi reporter/read/resolve; foreign reporter không đọc ticket người khác.
- **P11-T01-AC02:** Legacy Customer complaint vẫn đọc/resolve được; non-Customer được notify đúng ID/role, không null dereference từ old customer_id.
- **P11-T01-AC03:** Reply không sửa review gốc; moderation approve/reject lưu toàn bộ evidence/action/history và reason.

### P11-T02

**Failure incident và quyết định có evidence.** Tiên quyết task: P11-T01.

Thực hiện:

- Chuẩn hóa incident OPEN/RESOLVED, failure reason/evidence references, Admin alert dedupe; tích hợp incident tối thiểu P05/P07.
- Admin fail command chỉ trip PICKED_UP/IN_TRANSIT có incident operational, reason/key; dùng Delivery transition/Ordering events và terminal release.
- UI resolution REFUND_REQUESTED/NO_REFUND/NO_ACTION, không tự resolve complaint hay tạo redelivery.

Acceptance criteria:

- **P11-T02-AC01:** Failed event duplicate không tạo incident/alert nhiều lần; failure/terminal history có actor/reason.
- **P11-T02-AC02:** Driver locked sau pickup không bị reassign hoặc nhận thêm trip; Admin đóng FAILED theo policy rồi mới release capacity.
- **P11-T02-AC03:** Không restock sau pickup; resolving incident không tự ghi payment refunded.

### P11-T03

**Refund approval, execution và recovery.** Tiên quyết task: P11-T02.

Thực hiện:

- Refund request eligibility/full amount/approval và shared operation/reference với old reconciliation; không thêm refund worker song song xử lý cùng payment.
- Approve persist REFUND_PENDING/request/reference cùng transaction; provider call ngoài lock, query trước retry nếu uncertain, max5backoff và FAILED manual queue.
- UI Customer/Admin phân biệt requested/approved/processing/failed/confirmed, evidence links và reason; provider thật giữ deferred.

Acceptance criteria:

- **P11-T03-AC01:** DELIVERED cần complaint, DELIVERY_FAILED cần incident; amount chỉ toàn bộ Payment.amount đã thu; Restaurant/Driver không tự refund tiền khách.
- **P11-T03-AC02:** Concurrent approve/retry/webhook/late-payment/cancel chỉ tối đa một refund financial effect và một REFUNDED history.
- **P11-T03-AC03:** Crash trước/sau provider call recover bằng reference; no-confirmation không ghi REFUNDED; hết retry có alert và Admin retry reason/key.
- **P11-T03-AC04:** Refund delivered giữ Order DELIVERED và earning estimate; complaint không tự resolved; simulator success/failure/timeout đều có test.

## Kiểm chứng và exit gate

Reporter migration/authorization/review history, duplicate failure/locked-driver incident, approval rejection/full amount, provider unknown outcome, shared old-new queue races và cross-role E2E.

Chạy từ repo root sau khi tạo file test dự kiến và có môi trường cô lập:

```powershell
npx tsx --test tests/support-role-workflows.test.ts tests/delivery-incidents.test.ts tests/refund-workflow.test.ts
npm test
npm run test:e2e
npx tsc --noEmit
npm run check:openapi
npm run db:validate
```

Mỗi AC cần assertion/run thực tế. Checks blocked không tính pass; prerequisite/task chưa DONE thì phase chưa DONE. Giữ SOLID/module boundaries; UI giữ design system và accessibility.

## Migration và compatibility

Dual-read reporter fields trước staff-ticket rollout; giữ dữ liệu cũ. Refund unique/index + preflight payments đã REFUND_PENDING/REFUNDED để attach operation, không re-refund. Không đổi payment CHECK enum âm thầm: request FAILED không cần thêm payment REFUND_FAILED.

## Checkpoint và bàn giao

Ghi request/payment dual states, stable reference mapping, old reconciliation integration, migration/hold evidence và cases còn blocked. Tuyệt đối không ghi simulator success là provider thật. Trước task và sau patch/test cập nhật [STATUS](../state/STATUS.md), [TASKS](../state/TASKS.md), [HANDOFF](../state/HANDOFF.md). Nếu không hoàn tất ghi incident/next safe action theo [state protocol](../state/README.md); không bỏ qua AC hoặc chạy phase phụ thuộc.
