# Task registry

Trạng thái này là triển khai **ứng dụng**, không phải soạn tài liệu. Ban đầu tất cả 46 task NOT_STARTED; chưa có business acceptance evidence. Giữ ID ổn định, cập nhật cùng STATUS/HANDOFF; không xóa hàng để che blocker.

| Task                                                                  | Nội dung                                         | Trạng thái | Evidence/run                         | Incident |
| --------------------------------------------------------------------- | ------------------------------------------------ | ---------- | ------------------------------------ | -------- |
| [P00-T01](../phases/P00-baseline-and-execution.md#p00-t01)            | Xác minh baseline và giới hạn môi trường         | DONE       | [run](runs/20261112-2139-P00-T01.md) | —        |
| [P00-T02](../phases/P00-baseline-and-execution.md#p00-t02)            | Test isolation, timeout và cleanup               | DONE       | [run](runs/20261112-P00-T02.md)      | —        |
| [P00-T03](../phases/P00-baseline-and-execution.md#p00-t03)            | Registry, traceability và checkpoint ban đầu     | DONE       | [run](runs/20261112-P00-T03.md)      | —        |
| [P01-T01](../phases/P01-authorization-audit-checkout.md#p01-t01)      | Giới hạn quyền Admin và cập nhật callers         | DONE       | [run](runs/20261112-P01-T01.md)      | —        |
| [P01-T02](../phases/P01-authorization-audit-checkout.md#p01-t02)      | Audit có reason, resource type và outcome        | DONE       | [run](runs/20261112-P01-T02.md)      | —        |
| [P01-T03](../phases/P01-authorization-audit-checkout.md#p01-t03)      | Checkout retry trước catalog và routing          | DONE       | [run](runs/20261112-P01-T03.md)      | —        |
| [P02-T01](../phases/P02-driver-capacity-and-history.md#p02-t01)       | Preflight và backfill assignment legacy          | DONE       | [run](runs/20261112-P02-T01.md)      | —        |
| [P02-T02](../phases/P02-driver-capacity-and-history.md#p02-t02)       | Constraint một chuyến active và terminal release | DONE       | [run](runs/20261112-P02-T02.md)      | —        |
| [P02-T03](../phases/P02-driver-capacity-and-history.md#p02-t03)       | History và quyền xem dữ liệu Driver              | DONE       | [run](runs/20261112-P02-T03.md)      | —        |
| [P03-T01](../phases/P03-availability-and-location.md#p03-t01)         | Module Assignment và availability                | DONE       | [run](runs/20261112-P03-T01.md)      | —        |
| [P03-T02](../phases/P03-availability-and-location.md#p03-t02)         | GPS ingestion và latest location                 | DONE       | [run](runs/20261112-P03-T02.md)      | —        |
| [P03-T03](../phases/P03-availability-and-location.md#p03-t03)         | Driver workspace và GPS lifecycle                | DONE       | [run](runs/20261112-P03-T03.md)      | —        |
| [P04-T01](../phases/P04-assignment-search-and-offers.md#p04-t01)      | Search, offer, attempt và durable work           | DONE       | [run](runs/20261112-2331-P04-T01.md) | —        |
| [P04-T02](../phases/P04-assignment-search-and-offers.md#p04-t02)      | Strategy contract và Nearest Driver              | DONE       | [run](runs/20261112-2335-P04-T02.md) | —        |
| [P04-T03](../phases/P04-assignment-search-and-offers.md#p04-t03)      | OrderAccepted và worker tạo offer                | DONE       | [run](runs/20261112-2345-P04-T03.md) | —        |
| [P05-T01](../phases/P05-offer-response-and-core-workflow.md#p05-t01)  | Accept/reject nguyên tử và idempotent            | DONE       | [run](runs/20261112-2352-P05-T01.md) | —        |
| [P05-T02](../phases/P05-offer-response-and-core-workflow.md#p05-t02)  | Timeout, retry và exhaustion                     | DONE       | [run](runs/20261112-2358-P05-T02.md) | —        |
| [P05-T03](../phases/P05-offer-response-and-core-workflow.md#p05-t03)  | Role notifications and offer UI                  | DONE       | [run](runs/20261113-0227-P05-T03.md) | ?        |
| [P05-T04](../phases/P05-offer-response-and-core-workflow.md#p05-t04)  | Invalidation, race tests and core gate           | DONE       | [run](runs/20261113-1340-P05-T04.md) | ?        |
| [P06-T01](../phases/P06-realtime-tracking-and-navigation.md#p06-t01)  | Typed Redis transport and snapshot fallback      | DONE       | [run](runs/20261113-1354-P06-T01.md) | ?        |
| [P06-T02](../phases/P06-realtime-tracking-and-navigation.md#p06-t02)  | Tracking authorization and SSE lifecycle         | DONE       | [run](runs/20261113-1417-P06-T02.md) | ?        |
| [P06-T03](../phases/P06-realtime-tracking-and-navigation.md#p06-t03)  | Bản đồ, navigation và reconnect UI               | DONE       | [run](runs/20261113-1558-P06-T03.md) | —        |
| [P07-T01](../phases/P07-admin-monitoring-and-reassignment.md#p07-t01) | Monitoring queries, filters và pagination        | DONE       | [run](runs/20261113-1603-P07-T01.md) | —        |
| [P07-T02](../phases/P07-admin-monitoring-and-reassignment.md#p07-t02) | Attempts, alerts và operational dashboard        | DONE       | [run](runs/20261113-1613-P07-T02.md) | —        |
| [P07-T03](../phases/P07-admin-monitoring-and-reassignment.md#p07-t03) | Retry/reassign ngoại lệ và account lock          | DONE       | [run](runs/20261113-1621-P07-T03.md) | —        |
| [P08-T01](../phases/P08-restaurant-profile-menus-hours.md#p08-t01)    | Phone và lịch mở cửa có cấu trúc                 | DONE       | [run](runs/20261113-1629-P08-T01.md) | —        |
| [P08-T02](../phases/P08-restaurant-profile-menus-hours.md#p08-t02)    | CRUD nhóm món có ownership                       | DONE       | [run](runs/20261113-1636-P08-T02.md) | —        |
| [P08-T03](../phases/P08-restaurant-profile-menus-hours.md#p08-t03)    | Restaurant reject và workspace                   | DONE       | [run](runs/20261113-1645-P08-T03.md) | —        |
| [P09-T01](../phases/P09-inventory-ledger-and-alerts.md#p09-t01)       | Opening balance và StockMovement                 | DONE       | [run](runs/20261113-1651-P09-T01.md) | —        |
| [P09-T02](../phases/P09-inventory-ledger-and-alerts.md#p09-t02)       | Hợp nhất đường ghi tồn và stock adjustment       | DONE       | [run](runs/20261113-1700-P09-T02.md) | —        |
| [P09-T03](../phases/P09-inventory-ledger-and-alerts.md#p09-t03)       | Low-stock alert và effective sellability         | DONE       | [run](runs/20261113-1713-P09-T03.md) | —        |
| [P10-T01](../phases/P10-delivery-proof.md#p10-t01)                    | OTP challenge và verification                    | DONE       | [run](runs/20261113-1840-P10-T01.md) | —        |
| [P10-T02](../phases/P10-delivery-proof.md#p10-t02)                    | Private photo storage và authorization           | DONE       | [run](runs/20261113-1905-P10-T02.md) | —        |
| [P10-T03](../phases/P10-delivery-proof.md#p10-t03)                    | Proof requirement và completion UI               | DONE       | [run](runs/20261113-1935-P10-T03.md) | —        |
| [P11-T01](../phases/P11-support-review-failure-refund.md#p11-t01)     | Complaint đa role và review response             | DONE       | [run](runs/20261113-2010-P11-T01.md) | —        |
| [P11-T02](../phases/P11-support-review-failure-refund.md#p11-t02)     | Failure incident và quyết định có evidence       | DONE       | [run](runs/20261113-2040-P11-T02.md) | —        |
| [P11-T03](../phases/P11-support-review-failure-refund.md#p11-t03)     | Refund approval, execution và recovery           | DONE       | [run](runs/20261113-2130-P11-T03.md) | —        |
| [P12-T01](../phases/P12-dashboards-history-earnings.md#p12-t01)       | Restaurant metrics có định nghĩa rõ              | DONE       | [run](runs/20261113-2155-P12-T01.md) | —        |
| [P12-T02](../phases/P12-dashboards-history-earnings.md#p12-t02)       | Driver history, performance và earning           | DONE       | [run](runs/20261113-2215-P12-T02.md) | —        |
| [P12-T03](../phases/P12-dashboards-history-earnings.md#p12-t03)       | Admin KPI và time filters                        | DONE       | [run](runs/20261113-2240-P12-T03.md) | —        |
| [P13-T01](../phases/P13-assignment-strategies.md#p13-t01)             | Lowest ETA và fallback có nhãn                   | DONE       | [run](runs/20261113-2310-P13-T01.md) | —        |
| [P13-T02](../phases/P13-assignment-strategies.md#p13-t02)             | Balanced Load trong cửa sổ 24 giờ                | DONE       | [run](runs/20261113-2312-P13-T02.md) | —        |
| [P13-T03](../phases/P13-assignment-strategies.md#p13-t03)             | Strategy configuration và contract tests         | DONE       | [run](runs/20261113-2314-P13-T03.md) | —        |
| [P14-T01](../phases/P14-resilience-and-final-acceptance.md#p14-t01)   | External resilience và backlog recovery          | DONE       | [run](runs/20261113-2350-P14-T01.md) | —        |
| [P14-T02](../phases/P14-resilience-and-final-acceptance.md#p14-t02)   | CI PostgreSQL/Redis và role E2E                  | DONE       | [run](runs/20261114-0020-P14-T02.md) | —        |
| [P14-T03](../phases/P14-resilience-and-final-acceptance.md#p14-t03)   | Migration rehearsal và đóng coverage             | DONE       | [run](runs/20261114-0030-P14-T03.md) | —        |

Prerequisite nằm trong ROADMAP và file phase. DONE cần mọi AC có evidence và kiểm chứng phù hợp. Test chưa chạy là NOT_RUN/BLOCKED; P05-T04 phải chứng minh đủ 12 core criteria.
