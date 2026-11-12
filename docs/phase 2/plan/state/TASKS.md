# Task registry

Trạng thái này là triển khai **ứng dụng**, không phải soạn tài liệu. Ban đầu tất cả 46 task NOT_STARTED; chưa có business acceptance evidence. Giữ ID ổn định, cập nhật cùng STATUS/HANDOFF; không xóa hàng để che blocker.

| Task                                                                  | Nội dung                                         | Trạng thái  | Evidence/run | Incident |
| --------------------------------------------------------------------- | ------------------------------------------------ | ----------- | ------------ | -------- |
| [P00-T01](../phases/P00-baseline-and-execution.md#p00-t01)            | Xác minh baseline và giới hạn môi trường         | NOT_STARTED | —            | —        |
| [P00-T02](../phases/P00-baseline-and-execution.md#p00-t02)            | Test isolation, timeout và cleanup               | NOT_STARTED | —            | —        |
| [P00-T03](../phases/P00-baseline-and-execution.md#p00-t03)            | Registry, traceability và checkpoint ban đầu     | NOT_STARTED | —            | —        |
| [P01-T01](../phases/P01-authorization-audit-checkout.md#p01-t01)      | Giới hạn quyền Admin và cập nhật callers         | NOT_STARTED | —            | —        |
| [P01-T02](../phases/P01-authorization-audit-checkout.md#p01-t02)      | Audit có reason, resource type và outcome        | NOT_STARTED | —            | —        |
| [P01-T03](../phases/P01-authorization-audit-checkout.md#p01-t03)      | Checkout retry trước catalog và routing          | NOT_STARTED | —            | —        |
| [P02-T01](../phases/P02-driver-capacity-and-history.md#p02-t01)       | Preflight và backfill assignment legacy          | NOT_STARTED | —            | —        |
| [P02-T02](../phases/P02-driver-capacity-and-history.md#p02-t02)       | Constraint một chuyến active và terminal release | NOT_STARTED | —            | —        |
| [P02-T03](../phases/P02-driver-capacity-and-history.md#p02-t03)       | History và quyền xem dữ liệu Driver              | NOT_STARTED | —            | —        |
| [P03-T01](../phases/P03-availability-and-location.md#p03-t01)         | Module Assignment và availability                | NOT_STARTED | —            | —        |
| [P03-T02](../phases/P03-availability-and-location.md#p03-t02)         | GPS ingestion và latest location                 | NOT_STARTED | —            | —        |
| [P03-T03](../phases/P03-availability-and-location.md#p03-t03)         | Driver workspace và GPS lifecycle                | NOT_STARTED | —            | —        |
| [P04-T01](../phases/P04-assignment-search-and-offers.md#p04-t01)      | Search, offer, attempt và durable work           | NOT_STARTED | —            | —        |
| [P04-T02](../phases/P04-assignment-search-and-offers.md#p04-t02)      | Strategy contract và Nearest Driver              | NOT_STARTED | —            | —        |
| [P04-T03](../phases/P04-assignment-search-and-offers.md#p04-t03)      | OrderAccepted và worker tạo offer                | NOT_STARTED | —            | —        |
| [P05-T01](../phases/P05-offer-response-and-core-workflow.md#p05-t01)  | Accept/reject nguyên tử và idempotent            | NOT_STARTED | —            | —        |
| [P05-T02](../phases/P05-offer-response-and-core-workflow.md#p05-t02)  | Timeout, retry và exhaustion                     | NOT_STARTED | —            | —        |
| [P05-T03](../phases/P05-offer-response-and-core-workflow.md#p05-t03)  | Notification theo role và offer UI               | NOT_STARTED | —            | —        |
| [P05-T04](../phases/P05-offer-response-and-core-workflow.md#p05-t04)  | Invalidation, race tests và core gate            | NOT_STARTED | —            | —        |
| [P06-T01](../phases/P06-realtime-tracking-and-navigation.md#p06-t01)  | Typed Redis transport và snapshot fallback       | NOT_STARTED | —            | —        |
| [P06-T02](../phases/P06-realtime-tracking-and-navigation.md#p06-t02)  | Tracking authorization và SSE lifecycle          | NOT_STARTED | —            | —        |
| [P06-T03](../phases/P06-realtime-tracking-and-navigation.md#p06-t03)  | Bản đồ, navigation và reconnect UI               | NOT_STARTED | —            | —        |
| [P07-T01](../phases/P07-admin-monitoring-and-reassignment.md#p07-t01) | Monitoring queries, filters và pagination        | NOT_STARTED | —            | —        |
| [P07-T02](../phases/P07-admin-monitoring-and-reassignment.md#p07-t02) | Attempts, alerts và operational dashboard        | NOT_STARTED | —            | —        |
| [P07-T03](../phases/P07-admin-monitoring-and-reassignment.md#p07-t03) | Retry/reassign ngoại lệ và account lock          | NOT_STARTED | —            | —        |
| [P08-T01](../phases/P08-restaurant-profile-menus-hours.md#p08-t01)    | Phone và lịch mở cửa có cấu trúc                 | NOT_STARTED | —            | —        |
| [P08-T02](../phases/P08-restaurant-profile-menus-hours.md#p08-t02)    | CRUD nhóm món có ownership                       | NOT_STARTED | —            | —        |
| [P08-T03](../phases/P08-restaurant-profile-menus-hours.md#p08-t03)    | Restaurant reject và workspace                   | NOT_STARTED | —            | —        |
| [P09-T01](../phases/P09-inventory-ledger-and-alerts.md#p09-t01)       | Opening balance và StockMovement                 | NOT_STARTED | —            | —        |
| [P09-T02](../phases/P09-inventory-ledger-and-alerts.md#p09-t02)       | Hợp nhất đường ghi tồn và stock adjustment       | NOT_STARTED | —            | —        |
| [P09-T03](../phases/P09-inventory-ledger-and-alerts.md#p09-t03)       | Low-stock alert và effective sellability         | NOT_STARTED | —            | —        |
| [P10-T01](../phases/P10-delivery-proof.md#p10-t01)                    | OTP challenge và verification                    | NOT_STARTED | —            | —        |
| [P10-T02](../phases/P10-delivery-proof.md#p10-t02)                    | Private photo storage và authorization           | NOT_STARTED | —            | —        |
| [P10-T03](../phases/P10-delivery-proof.md#p10-t03)                    | Proof requirement và completion UI               | NOT_STARTED | —            | —        |
| [P11-T01](../phases/P11-support-review-failure-refund.md#p11-t01)     | Complaint đa role và review response             | NOT_STARTED | —            | —        |
| [P11-T02](../phases/P11-support-review-failure-refund.md#p11-t02)     | Failure incident và quyết định có evidence       | NOT_STARTED | —            | —        |
| [P11-T03](../phases/P11-support-review-failure-refund.md#p11-t03)     | Refund approval, execution và recovery           | NOT_STARTED | —            | —        |
| [P12-T01](../phases/P12-dashboards-history-earnings.md#p12-t01)       | Restaurant metrics có định nghĩa rõ              | NOT_STARTED | —            | —        |
| [P12-T02](../phases/P12-dashboards-history-earnings.md#p12-t02)       | Driver history, performance và earning           | NOT_STARTED | —            | —        |
| [P12-T03](../phases/P12-dashboards-history-earnings.md#p12-t03)       | Admin KPI và time filters                        | NOT_STARTED | —            | —        |
| [P13-T01](../phases/P13-assignment-strategies.md#p13-t01)             | Lowest ETA và fallback có nhãn                   | NOT_STARTED | —            | —        |
| [P13-T02](../phases/P13-assignment-strategies.md#p13-t02)             | Balanced Load trong cửa sổ 24 giờ                | NOT_STARTED | —            | —        |
| [P13-T03](../phases/P13-assignment-strategies.md#p13-t03)             | Strategy configuration và contract tests         | NOT_STARTED | —            | —        |
| [P14-T01](../phases/P14-resilience-and-final-acceptance.md#p14-t01)   | External resilience và backlog recovery          | NOT_STARTED | —            | —        |
| [P14-T02](../phases/P14-resilience-and-final-acceptance.md#p14-t02)   | CI PostgreSQL/Redis và role E2E                  | NOT_STARTED | —            | —        |
| [P14-T03](../phases/P14-resilience-and-final-acceptance.md#p14-t03)   | Migration rehearsal và đóng coverage             | NOT_STARTED | —            | —        |

Prerequisite nằm trong ROADMAP và file phase. DONE cần mọi AC có evidence và kiểm chứng phù hợp. Test chưa chạy là NOT_RUN/BLOCKED; P05-T04 phải chứng minh đủ 12 core criteria.
