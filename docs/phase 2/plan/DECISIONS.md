# Quyết định và mặc định triển khai

Ngày chốt phạm vi: 12/11/2026, Asia/Saigon. D01–D08 là lựa chọn trực tiếp của người dùng; các mục sau là mặc định kỹ thuật của plan đã được yêu cầu triển khai. Thay đổi phải ghi lý do/ảnh hưởng ở đây và các contract/phase liên quan, không để model sau tự suy đoán lại.

| ID  | Quyết định                                                         | Hệ quả                                                                                                                                            |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| D01 | Hoàn thiện demo trên simulator                                     | Không cung cấp tiền thật/payout/provider thật trong P00–P14.                                                                                      |
| D02 | Admin không sửa menu/giá/profile kinh doanh                        | Chỉ Restaurant member ghi Catalog; Admin approval/moderation/archive vì vi phạm có reason.                                                        |
| D03 | Không giao lại sau pickup                                          | FAILED là terminal Delivery; giải phóng capacity và mở incident; không restock món đã lấy.                                                        |
| D04 | Refund toàn bộ tiền theo quyết định Admin                          | Không partial refund; failed cần incident, delivered cần complaint; cancellation hợp lệ trước acceptance giữ auto-refund hiện có.                 |
| D05 | Giữ pedestrian routing và shipping formula                         | Nhãn rõ đi bộ; Haversine chỉ lọc/xếp hạng, không tính phí hoặc giả route distance.                                                                |
| D06 | OTP hoặc ảnh đều hợp lệ                                            | Một proof VERIFIED đủ hoàn tất; không buộc cả hai; ảnh private trong demo.                                                                        |
| D07 | Earning estimate = 100% snapshot delivery fee của chuyến DELIVERED | Không phải tiền thực nhận; không tự thu hồi estimate do customer refund.                                                                          |
| D08 | Chặn chủ động offline khi đang có chuyến active                    | Có thể `ready=false`; account lock/mất heartbeat là ngoại lệ, không được xóa assignment để giả offline an toàn.                                   |
| D09 | Một Driver/một Delivery tối đa một assignment active               | DriverAssignment vẫn thuộc Delivery; không tạo bảng Assignment confirmed song song.                                                               |
| D10 | Assignment sở hữu availability/search/offer/attempt                | Location sở hữu GPS; Identity account/session; Delivery capacity/trip. Nối port tại composition root để tránh cycle.                              |
| D11 | Search là durable work item                                        | OrderAccepted sync handler ghi search trong transaction Accepted. Worker xử lý sau commit; không biến notification outbox thành broker tổng quát. |
| D12 | Giữ trạng thái Order hiện có                                       | Restaurant reject trước acceptance dùng CANCELLED + reason/action; delivery failure vẫn DELIVERY_FAILED; refund delivered không sửa Order status. |
| D13 | Delivery terminal đóng occupancy, history độc lập                  | Current trip access chỉ final/current driver; revoked assignment history redacted. Không dùng active cho mọi truy vấn lịch sử.                    |
| D14 | Manual override không bypass eligibility                           | Sau P05 chỉ Admin với reason/exception hợp lệ; retry/reassign dùng cùng invariant và idempotency với automation.                                  |
| D15 | Time và retention tối thiểu                                        | Tiền integer VND; mốc nghiệp vụ UTC trong DB; UI ngày địa phương Asia/Saigon; không lưu trajectory mặc định.                                      |

## Cấu hình tập trung

Thêm parser cấu hình có validate và default, inject policy vào application/domain. Chỉ sửa `.env.example` và docs khi thêm biến; không sửa `.env` người dùng.

| Cấu hình                               | Default                      | Quy tắc                                                                                |
| -------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| `ASSIGNMENT_AUTOMATION_ENABLED`        | false ở P03–P04; true từ P05 | Có test cho cả mode trong giai đoạn chuyển tiếp; manual mode không nới capacity guard. |
| `ASSIGNMENT_STRATEGY`                  | NEAREST                      | LOWEST_ETA/BALANCED_LOAD chỉ được chọn sau P13; giá trị lạ fail startup.               |
| `ASSIGNMENT_OFFER_TTL_SECONDS`         | 30                           | Accept khi DB now >= expires_at bị từ chối.                                            |
| `ASSIGNMENT_RADIUS_METERS`             | 5000                         | Khoảng cách tọa độ tới pickup; không thay service range shipping 15 km.                |
| `ASSIGNMENT_MAX_OFFERS`                | 10                           | Tổng offer đã tạo trong một generation, không phải mỗi vòng.                           |
| `ASSIGNMENT_MAX_ROUNDS`                | 3                            | Vòng 1 ngay, chờ 30 giây trước vòng 2 và 60 giây trước vòng 3.                         |
| `ASSIGNMENT_SEARCH_DEADLINE_SECONDS`   | 600                          | Kết thúc khi chạm deadline/offer cap/vòng cuối; không retry vô hạn.                    |
| `DRIVER_LOCATION_MAX_AGE_SECONDS`      | 90                           | Kiểm tra captured_at và received_at; không tin timestamp client để kéo dài freshness.  |
| `DRIVER_LOCATION_MAX_FUTURE_SECONDS`   | 15                           | So với đồng hồ DB; timestamp đảo thứ tự trả conflict.                                  |
| `DRIVER_LOCATION_MIN_INTERVAL_SECONDS` | 5                            | Giới hạn backend theo Driver; UI gửi khoảng 10 giây khi có cập nhật.                   |
| `DRIVER_HEARTBEAT_INTERVAL_SECONDS`    | 30                           | Heartbeat active/online; không coi heartbeat là GPS mới.                               |
| `DRIVER_HEARTBEAT_MAX_AGE_SECONDS`     | 90                           | Mất heartbeat loại khỏi eligibility; không giải phóng capacity đang giữ.               |
| `TRACKING_LOCATION_TTL_SECONDS`        | 120                          | Redis latest; PostgreSQL là latest snapshot phục vụ eligibility/fallback.              |
| `OFFLINE_LOCATION_RETENTION_SECONDS`   | 900                          | Purge latest khi offline/mất heartbeat đủ 15 phút, không có chuyến active.             |
| `TRACKING_POLL_SECONDS`                | 15                           | Fallback khi stream không khả dụng; hiện rõ stale/disconnected.                        |
| `LOW_STOCK_THRESHOLD`                  | 5                            | Alert một lần khi từ > threshold xuống <= threshold; rearm khi vượt threshold.         |
| `DELIVERY_PROOF_REQUIRED`              | true từ P10                  | Snapshot vào Delivery mới; legacy default false.                                       |
| `DELIVERY_OTP_TTL_SECONDS`             | 600                          | 6 digits, hash với random salt; không lưu plaintext.                                   |
| `DELIVERY_OTP_MAX_ATTEMPTS`            | 5                            | Hết lượt khóa challenge; Customer phải tạo challenge mới.                              |
| `DELIVERY_PROOF_MAX_BYTES`             | 5242880                      | JPEG/PNG, kiểm tra magic bytes, private storage.                                       |
| `DELIVERY_PROOF_RETENTION_DAYS`        | 30                           | Purge ảnh sau 30 ngày khi không có complaint/incident mở; giữ metadata audit.          |
| `DELIVERY_PROOF_STORAGE_DIR`           | `.data/delivery-proofs`      | Không thuộc static/public; document local single-instance demo.                        |
| `REFUND_MAX_ATTEMPTS`                  | 5                            | Retry 30/60/120/240 giây sau lần đầu; hết lượt cần Admin retry có reason.              |
| `EXTERNAL_BREAKER_FAILURES`            | 5                            | Lỗi liên tiếp timeout/network/5xx; 4xx nghiệp vụ không trip breaker.                   |
| `EXTERNAL_BREAKER_OPEN_SECONDS`        | 30                           | Half-open một probe/process; state local, không tuyên bố distributed resilience.       |

## Quy tắc chi tiết

- Eligibility: account active, online, ready, heartbeat/GPS đủ mới, không active trip, không pending offer khác và trong radius. Driver đã từng được offer trong generation không được mời lại; Admin retry là generation mới.
- Vòng tìm: lấy tối đa số ứng viên còn lại trong tổng cap, xếp hạng ổn định. Mỗi ứng viên tạo một offer, thử tiếp khi reject/timeout/invalidation; hết danh sách thì chờ backoff và refresh candidates ở vòng sau. Có thể kết thúc sớm theo cap/deadline. Admin nhận alert một lần/generation khi EXHAUSTED.
- Online yêu cầu quyền GPS và một vị trí đủ mới. Cho Driver active gửi location ở trạng thái offline để chuẩn bị online; không đòi assignment. Sau pickup, vị trí được nhận theo assignment còn hiệu lực dù heartbeat gián đoạn, nhưng account bị khóa vẫn bị chặn.
- Pickup phải READY_FOR_PICKUP. ARRIVED tại quán là mốc bổ sung trước pickup, không đổi state chuẩn bị món và không cho phép pickup sớm.
- Account lock trước pickup: chặn accept ngay qua active check; durable invalidation xử lý revoke/retry sau commit. Sau pickup: giữ trip/occupancy, tạo incident để Admin kết thúc FAILED theo exception policy; không cho Driver bị khóa tự cập nhật bằng session cũ.
- Refund allowed: cancellation trước acceptance theo luồng cũ; DELIVERY_FAILED có incident; DELIVERED có complaint. Không refund order ACCEPTED/PREPARING/READY đang hoạt động ngoài các policy trên. Admin approve/reject có reason; không tự approve delivered/failed.
- Complaint refund không tự resolve complaint; resolution và financial execution là hai trạng thái độc lập. FAILED refund không được trình bày là đã trả tiền.
- Opening schedule có cấu trúc thì authoritative; không có thì giữ hành vi cũ. Manual accepting_orders=false/hidden/not-approved luôn chặn order bất kể lịch. Không parse tự động chuỗi opening_hours cũ.
- Effective sellability = approved + visible restaurant + manual accepting + giờ phục vụ + item visible + item available + stock>0. Không tự đổi cờ manual available khi stock=0, để release/restock không vô tình mở bán món đã bị chủ quán tắt.
- Không tự ước lượng dữ liệu lịch sử thiếu: metrics cần mốc không có thì trả null và coverage count; estimate legacy chỉ tạo khi xác định được final Driver và delivery fee snapshot.
