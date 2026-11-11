# Các vấn đề đã biết của thông báo realtime (SSE + Redis Pub/Sub)

Kết quả review bản triển khai trên nhánh `feat/notification-sse` (commit `45afc96` → `5121ac8`).
Các mục xếp theo mức độ nghiêm trọng. Trạng thái: **chưa sửa**.

| #   | Mức độ                  | Vấn đề                                                              | Trạng thái |
| --- | ----------------------- | ------------------------------------------------------------------- | ---------- |
| 1   | 🔴 Nghiêm trọng (fatal) | Restaurant, driver, admin không nhận đơn mới theo thời gian thực    | Chưa sửa   |
| 2   | 🟠 Lớn                  | Redis sập làm treo worker nghiệp vụ                                 | Chưa sửa   |
| 3   | 🟠 Lớn                  | Mất push khi SSE vẫn mở, client không khôi phục                     | Chưa sửa   |
| 4   | 🟠 Lớn                  | Replay theo `Last-Event-ID` có thể bỏ sót thông báo                 | Chưa sửa   |
| 5   | 🟡 Trung bình           | Kết nối ma (ghost connection) + 429 khiến client fallback vĩnh viễn | Chưa sửa   |
| 6–9 | 🟢 Nhỏ                  | Revocation chậm, lỗi replay sau header, shutdown, đồng hồ           | Chưa sửa   |

---

## 1. 🔴 Restaurant, driver, admin không nhận đơn mới theo thời gian thực

**Hiện tượng.** `notify()` chỉ được gọi cho customer:

- `server/modules/ordering/application/checkout.ts:119` → `actor.id` (customer)
- `server/modules/ordering/application/order-lifecycle.ts:27` → `order.customer_id`
- `server/modules/support/support.service.ts:26` → `complaint.customer_id`

Restaurant, driver và admin không bao giờ nhận push. Trước đây poll 7 giây che đi điều này.
Sau khi bỏ poll, `orderList` của các role này chỉ làm mới khi SSE vừa mở kết nối (`onopen`)
hoặc khi chính họ thực hiện một hành động. `refreshStaff` (poll 30 giây) **không** gọi `/orders`.

**Hậu quả.** Restaurant không thấy đơn mới, driver không thấy đơn được giao. Đây là hồi quy
(regression) so với bản polling.

**Vì sao không bị phát hiện.** Kịch bản e2e chỉ test bằng tài khoản customer.

**Đề xuất sửa.**

- Publish thêm một tín hiệu nhẹ "orders changed" (không lưu vào inbox) tới chủ restaurant,
  driver được giao và admin khi đơn được tạo hoặc đổi trạng thái. Client nhận tín hiệu thì refetch `/orders`.
- Giải pháp tạm: thêm `/orders` vào poll của `refreshStaff` cho role khác customer.

## 2. 🟠 Redis sập làm treo worker nghiệp vụ

**Hiện tượng.** Đo thực tế khi Redis không khả dụng: mỗi lần `publish` mất khoảng
**231 ms → 422 ms → 1369 ms**, tăng dần theo backoff của ioredis (offline queue + retry).
`publishDelivered()` trong `notification.service.ts` `await` tuần tự từng event (tối đa 50 mỗi batch).

Worker trong `server/index.ts` chạy chung một vòng lặp với **đối soát thanh toán (payment reconciliation)**
và **hết hạn đơn chưa thanh toán**, có cờ `running` chặn tick tiếp theo.

**Hậu quả.** Redis vốn là thành phần tùy chọn, nhưng khi sập sẽ làm chậm lõi nghiệp vụ trong nhiều phút.

**Đề xuất sửa.**

- Publisher dùng `enableOfflineQueue: false` để fail ngay khi mất kết nối.
- Publish song song (`Promise.allSettled`) có timeout, hoặc fire-and-forget không chặn worker.

## 3. 🟠 Mất push khi SSE vẫn đang mở, client không khôi phục

**Hiện tượng.** Thiết kế giả định "mất tin thì reconnect sẽ replay". Nhưng các trường hợp sau
**không làm đứt kết nối SSE**:

- Redis chập chờn, subscriber bỏ lỡ message trong lúc reconnect.
- Publish lỗi (chỉ log).
- Redis chưa lên lúc server khởi động: bus vẫn khác `null` nên stream vẫn được chấp nhận.

Client không reconnect, không fallback (fallback chỉ chạy khi `readyState === CLOSED`),
và thông báo mất âm thầm cho đến khi reload trang.

**Đề xuất sửa.**

- Khi subscriber kết nối lại Redis (event `ready` sau một lần lỗi), gửi frame `resync`
  tới mọi stream local để client refetch.
- Cân nhắc một lần refresh an toàn chậm (ví dụ 2–5 phút) phía client.

## 4. 🟠 Replay theo `Last-Event-ID` có thể bỏ sót thông báo

**Hiện tượng.** `listAfter()` dùng cursor `(created_at, id)`:

- Mọi notification trong một batch worker có **cùng `created_at`**, vì `now()` của Postgres
  là thời điểm bắt đầu transaction. Tie-break bằng UUID ngẫu nhiên không khớp thứ tự publish.
  Ví dụ: client nhận A rồi rớt mạng trước B; nếu `id(B) < id(A)` thì replay bỏ qua B.
- Nhiều instance: thứ tự commit có thể khác thứ tự `created_at`.
- Lúc tải trang có race nhỏ giữa lấy snapshot `/notifications` và đăng ký stream.
- `onopen` của client chỉ refetch `/orders`, **không** refetch `/notifications`.

**Đề xuất sửa.** Mỗi lần `onopen` thì refetch `/notifications` (client đã có dedupe theo id).
Một request mỗi lần reconnect lấp được cả các lỗ trên; replay giữ lại như một tối ưu.

## 5. 🟡 Kết nối ma + 429 khiến client fallback vĩnh viễn

**Hiện tượng.** TCP half-open (thường gặp trên mạng di động) không được phát hiện nhanh,
nên kết nối ma vẫn chiếm chỗ trong giới hạn `MAX_STREAMS_PER_USER = 5`. Khi đủ 5,
request mới nhận 429, `EventSource` chuyển sang `CLOSED` và client poll 30 giây mãi mãi,
không thử lại SSE.

**Đề xuất sửa.**

- Server: đuổi kết nối cũ nhất của user thay vì từ chối kết nối mới.
- Client: khi `CLOSED`, thử mở lại SSE sau một khoảng backoff thay vì chỉ poll.

## 6–9. 🟢 Vấn đề nhỏ

6. **Logout/deactivate không đóng stream ngay.** Session chỉ được re-validate mỗi
   `REVALIDATE_EVERY × HEARTBEAT_MS` ≈ 2 phút. Có thể đóng stream chủ động khi logout.
7. **Replay lỗi sau khi đã gửi header.** Nếu `replaySince()` lỗi sau `flushHeaders()`, error handler
   cố gửi JSON và gây `ERR_HTTP_HEADERS_SENT`. Nên bọc `try/catch` và gửi `resync`.
   Guard `write()` cũng nên kiểm tra thêm `res.destroyed`.
8. **Shutdown có thể treo.** Một stream mới mở trên socket keep-alive sau `closeAllStreams()`
   có thể giữ `server.close()`. Nên từ chối stream mới khi đang shutdown và đặt timeout gọi
   `server.closeAllConnections()`.
9. **`created_at` trong push lấy theo đồng hồ app**, không phải giá trị trong DB, nên có thể
   lệch nhẹ so với dữ liệu trả về từ `/notifications`.

Ngoài ra: nếu triển khai nhiều instance mà một số instance thiếu `REDIS_URL`, worker trên
instance đó vẫn claim outbox nhưng không publish, nên push bị mất. Mọi instance phải cùng cấu hình.

---

## Đã kiểm tra, không có vấn đề

- Trên Node 24, `req.on('close')` bắn khi client ngắt kết nối, nên dọn dẹp kết nối hoạt động đúng.
- Ghi vào response đã bị hủy chỉ trả về `false`, không crash process.
- Publish diễn ra sau commit, đúng thứ tự.
- `tests/module-boundaries.test.ts` pass; endpoint stream là GET, xác thực bằng cookie HttpOnly,
  không có lỗ hổng CSRF hay cross-origin.

## Thứ tự sửa đề xuất

1. Mục 1 (fatal).
2. Mục 2.
3. Mục 3 + 4 (gộp một commit vì cùng là bài toán resync).
4. Mục 5 và các mục nhỏ.
