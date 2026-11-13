# Traceability từ audit tới task và nghiệm thu

Nguồn là mục 4 (20 phần partial), mục 5 (13 phần chưa làm) và mục 7 (12 core AC) của [audit](../IMPLEMENTATION_STATUS_AUDIT.md). Giữ ID Gxx/Axx ổn định. Trạng thái PLANNED là chưa code; chỉ chuyển VERIFIED khi có task DONE và run evidence liên kết. Payment/provider thật được DEFERRED riêng, không đánh đồng với simulator.

## Khoảng trống chức năng

| Gap  | Hạng mục audit                                   | Task chịu trách nhiệm              | Status   | Evidence khi hoàn thành                                                                                                                        |
| ---- | ------------------------------------------------ | ---------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| G01  | Restaurant profile/phone/hours                   | P08-T01                            | VERIFIED | [P08-T01](state/runs/20261113-1629-P08-T01.md)                                                                                                 |
| G02  | CRUD menu group độc lập                          | P08-T02                            | VERIFIED | [P08-T02](state/runs/20261113-1636-P08-T02.md)                                                                                                 |
| G03  | Inventory ledger/low-stock/effective unavailable | P09-T01, P09-T02, P09-T03          | VERIFIED | [P09-T01](state/runs/20261113-1651-P09-T01.md), [P09-T02](state/runs/20261113-1700-P09-T02.md), [P09-T03](state/runs/20261113-1713-P09-T03.md) |
| G04  | Restaurant reject có reason                      | P08-T03                            | VERIFIED | [P08-T03](state/runs/20261113-1645-P08-T03.md)                                                                                                 |
| G05  | Restaurant theo dõi Driver/arrival/pickup        | P05-T03, P06-T03                   | VERIFIED | [P05-T03](state/runs/20261113-0227-P05-T03.md), [P06-T03](state/runs/20261113-1558-P06-T03.md)                                                 |
| G06  | Restaurant dashboard/doanh thu/performance       | P12-T01                            | PLANNED  | Metric formula/cohort/UTC vs local tests                                                                                                       |
| G07  | Restaurant reply/request moderation              | P11-T01                            | VERIFIED | [P11-T01](state/runs/20261113-2010-P11-T01.md)                                                                                                 |
| G08  | Driver pickup/dropoff trip info/navigation       | P05-T03, P06-T03                   | VERIFIED | [P05-T03](state/runs/20261113-0227-P05-T03.md), [P06-T03](state/runs/20261113-1558-P06-T03.md)                                                 |
| G09  | Driver history riêng/pagination/earning          | P02-T03, P12-T02                   | PLANNED  | Revoked privacy + terminal history + estimate snapshot                                                                                         |
| G10  | Account status reason và lock đang có chuyến     | P01-T02, P05-T04, P07-T03          | VERIFIED | [P01-T02](state/runs/20261112-P01-T02.md), [P05-T04](state/runs/20261113-1340-P05-T04.md), [P07-T03](state/runs/20261113-1621-P07-T03.md)      |
| G11  | Admin filters/monitoring/KPI                     | P07-T01, P07-T02, P12-T03          | PLANNED  | Queries/pagination/role KPI tests                                                                                                              |
| G12  | Reassign ngoại lệ có reason/idempotency          | P05-T04, P07-T03                   | VERIFIED | [P05-T04](state/runs/20261113-1340-P05-T04.md), [P07-T03](state/runs/20261113-1621-P07-T03.md)                                                 |
| G13  | Delivery failed resolution/alert/refund          | P05-T03, P11-T02, P11-T03          | PLANNED  | Failure incident + approval + recovery; no redelivery                                                                                          |
| G14a | Payment/refund/reconcile simulator hoàn chỉnh    | P11-T03, P14-T01                   | PLANNED  | Stable reference, approval, timeout/crash tests                                                                                                |
| G14b | Payment/refund provider thật                     | EXT01                              | DEFERRED | Điều kiện trong DEFERRED_EXTERNALS, không simulator pass                                                                                       |
| G15  | Complaint Restaurant/Driver và refund linkage    | P11-T01, P11-T03                   | PLANNED  | Reporter migration/ownership/financial guards                                                                                                  |
| G16  | Audit type/outcome/reason/attempt history        | P01-T02, P04-T01, P05-T01, P07-T03 | PLANNED  | Audit atomic/legacy UNKNOWN/no secrets                                                                                                         |
| G17  | Notification cho các role/offer/alerts           | P05-T03, P07-T02                   | PLANNED  | Recipient + dedupe + staff UI refresh                                                                                                          |
| G18  | OrderAccepted/durable assignment work            | P04-T01, P04-T03                   | PLANNED  | Accepted rollback/duplicate/restart lease tests                                                                                                |
| G19  | Checkout idempotency/assignment concurrency      | P01-T03, P02-T02, P05-T01, P05-T04 | PLANNED  | Changed catalog/address retry + DB race                                                                                                        |
| G20  | External timeout/retry/cache/breaker             | P06-T01, P14-T01                   | PLANNED  | Redis outage/read fallback + provider fault suite                                                                                              |
| G21  | Automatic Driver Assignment                      | P04-T03, P05-T01, P05-T02          | PLANNED  | Accept→offer→assignment không Admin happy path                                                                                                 |
| G22  | Nearest strategy/interface/module boundary       | P03-T01, P04-T02                   | PLANNED  | Pure strategy contract + graph tests                                                                                                           |
| G23  | Driver Availability                              | P03-T01, P03-T03                   | PLANNED  | Online/ready/heartbeat + active-trip guard                                                                                                     |
| G24  | GPS/staleness/operational region                 | P03-T02, P03-T03                   | PLANNED  | Bounds/time/order/rate/radius/private data tests                                                                                               |
| G25  | DriverOffer/attempt/response/expiry              | P04-T01, P05-T01, P05-T02          | PLANNED  | State machine + response/expiry races                                                                                                          |
| G26  | Một chuyến active/Driver                         | P02-T01, P02-T02, P05-T04          | PLANNED  | Legacy conflict preflight + concurrent DB transactions                                                                                         |
| G27  | Atomic accept/revalidation/idempotency           | P05-T01, P05-T04                   | PLANNED  | Reject offline/busy/expired and no duplicate effects                                                                                           |
| G28  | Authorized realtime GPS/retention                | P06-T01, P06-T02, P06-T03          | PLANNED  | Stream revoke/reconnect/poll + retention                                                                                                       |
| G29  | No-candidate fallback và monitoring              | P05-T02, P07-T01, P07-T02          | PLANNED  | Exhaustion persists + alert once + admin query                                                                                                 |
| G30  | OTP/photo proof                                  | P10-T01, P10-T02, P10-T03          | VERIFIED | [P10-T01](state/runs/20261113-1840-P10-T01.md), [P10-T02](state/runs/20261113-1905-P10-T02.md), [P10-T03](state/runs/20261113-1935-P10-T03.md) |
| G31  | Driver earning/performance                       | P12-T02                            | PLANNED  | Estimate unique/delivery + labels; payout EXT02                                                                                                |
| G32  | Lowest ETA/Balanced Load                         | P13-T01, P13-T02, P13-T03          | PLANNED  | Walking ETA fallback + rolling-load fixtures                                                                                                   |
| G33  | Failure compensation/Saga và breaker             | P11-T02, P11-T03, P14-T01          | PLANNED  | Durable state machine approval/retry; không ép GoF Saga class                                                                                  |
| G34  | Admin policy khác DOCX                           | P01-T01, P07-T03                   | PLANNED  | Catalog writes403, audited suspend/exception commands                                                                                          |

Các mục G01–G20 gom đúng phạm vi partial của audit; tracking Restaurant và thông tin Driver có thể chia nhiều task, provider thật tách G14b. G21–G33 bao phủ nhóm chưa làm. Không coi phần đã có tên entity là đã hoàn tất workflow.

## Core gate ở P05-T04

| AC gốc | Bắt buộc chứng minh                                              | Task / test group                               |
| ------ | ---------------------------------------------------------------- | ----------------------------------------------- |
| A01    | Restaurant Accepted kích hoạt một workflow kể cả event lặp/crash | P04-T03, P05-T04 / assignment-workflow          |
| A02    | Chỉ account active/online/ready/fresh/not-busy đủ region         | P03-T01, P03-T02, P05-T01 / eligibility         |
| A03    | Offer có expiry đến đúng Driver                                  | P04-T03, P05-T03 / offers + recipients          |
| A04    | Driver accept/reject                                             | P05-T01, P05-T03 / command + browser            |
| A05    | Reject/timeout chuyển ứng viên                                   | P05-T02 / worker clock tests                    |
| A06    | Hai Order không chiếm cùng Driver                                | P02-T02, P05-T04 / PostgreSQL concurrency       |
| A07    | Offline/busy/expired accept bị từ chối                           | P05-T01, P05-T04 / races                        |
| A08    | Không ứng viên có waiting/exhausted và Admin theo dõi            | P05-T02, P05-T03 / minimal monitoring           |
| A09    | Pickup chỉ khi Ready                                             | P05-T04 / existing + regression                 |
| A10    | Restaurant/Driver/Customer không truy cập chéo                   | P01-T01, P02-T03, P05-T04 / authorization       |
| A11    | Sensitive actions/attempt có history/reason                      | P01-T02, P04-T01, P05-T04 / audit               |
| A12    | Existing tests/API tương thích hoặc có tightening migration rõ   | P05-T04 / compatibility + OpenAPI + updated E2E |

Mỗi Axx phải được ghi PASS với run/test assertion tại P05-T04, không chỉ link file test tồn tại. P14 kiểm lại sau khi proof/refund/report được thêm.

P05-T04: **A01?A12 PASS**, each with its assertion and run evidence in [the core gate run](state/runs/20261113-1340-P05-T04.md).

## Ngoài phạm vi có chủ đích

EXT01–EXT06 trong [DEFERRED_EXTERNALS](DEFERRED_EXTERNALS.md) giữ DEFERRED. Source audit không được sửa để xóa gap chưa làm; chỉ cập nhật matrix với evidence hoặc decision mới.
