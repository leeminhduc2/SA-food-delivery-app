# Quy tắc engineering và nghiệm thu

Các quy tắc này áp dụng cho code triển khai tương lai, không yêu cầu sửa toàn bộ code cũ ngoài phạm vi task. Tham chiếu [decisions](DECISIONS.md) và [contracts](CONTRACTS.md).

## SOLID kiểm chứng được

| Nguyên tắc | Bắt buộc trong thay đổi                                                                                                                                                          | Bằng chứng                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| SRP        | Route validate/authorize/delegate; application điều phối; domain giữ invariant; repository/provider giữ I/O. Tách offer response, candidate ranking, tracking, refund và report. | Review module trách nhiệm và behavior tests; controller không có transaction/ranking loop.  |
| OCP        | AssignmentStrategy và provider port có interface nhỏ. Chọn implementation bằng composition/config, không switch strategy trong controller.                                       | Thêm strategy qua registry/factory và contract suite mà không sửa assignment state machine. |
| LSP        | Strategy không tự assign hoặc mutate candidate; provider không trả success giả khi timeout. Tất cả implementation trả cùng typed result/error semantics.                         | Cùng contract tests chạy trên từng implementation/fake.                                     |
| ISP        | Tách CandidateLocationReader, RouteEstimator, DriverCapacityGateway, DeliveryOrderGateway, ProofStorage, PaymentProvider.                                                        | Caller chỉ nhận capability cần dùng; không truyền service toàn năng.                        |
| DIP        | Domain chỉ dùng plain types/policy/clock interfaces; application nhận ports; adapters nối tại composition root.                                                                  | Module-boundary/domain-purity tests pass; không import Express/Prisma/Redis vào domain.     |

Không bắt buộc class hoặc interface cho từng hàm. Không tạo abstract repository chung/generic service chỉ để có pattern. Tách component và hook khi cần quản lý role/stream/GPS; không thêm toàn bộ workflow vào App.tsx.

Strategy interface và phép sort thuần có thể nằm domain; implementation cần gọi RouteEstimator/Delivery query đặt ở application/strategies và nhận port qua injection. Không đưa I/O vào domain rồi gọi đó là pure chỉ vì đã bọc interface.

## Ownership và dependency

- Giữ public import qua module `index.ts`; shared không import module.
- Assignment sở hữu DriverAvailability, AssignmentSearch, DriverOffer, AssignmentAttempt, operational invalidation work.
- Delivery sở hữu Delivery, DriverAssignment và proof; Location sở hữu DriverLocation; Payment sở hữu RefundRequest/refund execution; Support sở hữu Complaint; Review sở hữu reply/moderation request.
- Module khác chỉ đọc/ghi qua public API/port. Projection read-only là ngoại lệ có tên, khai báo trong test; không dùng projection để viết bảng module khác.
- Thêm model/table mới vào ownership map của `tests/module-boundaries.test.ts`; không nới regex/exception để che vi phạm.
- Delivery không import Assignment. Location không import Ordering để authorize tracking; dùng TrackingAccessGateway do composition root nối. Ordering có thể triển khai gateway và subscribe event mà không tạo import cycle.

## Transaction và khóa

Thứ tự tương thích với cancel/payment hiện có: **Order → Payment nếu cần → Delivery → User của Driver → DriverAvailability → Search/Offer**, mỗi nhóm nhiều ID khóa tăng dần. Với checkout, giữ customer/key advisory lock rồi restaurant/item locks theo thứ tự hiện tại; không nối provider/network call vào transaction giữ stock lock.

- Identity cung cấp capability khóa/đọc account Driver; Assignment cung cấp lock availability, Delivery cung cấp capacity/confirmed assignment. Không raw-query bảng module khác trong service.
- Accept/override đọc offer metadata không khóa để biết order trước, sau đó khóa theo thứ tự trên và đọc lại điều kiện. Recheck account/availability/GPS/order/expiry/capacity trong transaction; unique constraint là hàng rào cuối.
- Availability/account change khóa User/availability rồi chỉ ghi trạng thái và durable invalidation work; **không khóa Order/Delivery ngược thứ tự trong cùng transaction**. Worker xử lý invalidation theo lock order chuẩn. Accept check trạng thái mới ngay, không chờ worker để từ chối.
- Closing trip không cần đổi ready của Driver; busy được tính từ active assignment, ready là lựa chọn Driver. Không coi kết thúc heartbeat là giải phóng trip.
- Worker claim có lease/conditional update; không giữ khóa claim khi gọi map. Trước ghi kết quả phải kiểm tra generation/version/lease còn hiệu lực. Worker chết thì lease hết hạn và instance khác tiếp tục.
- Dùng DB now cho expiry/deadline. Không dựa vào frontend countdown hoặc Redis TTL để chấp nhận offer.
- Các event handler sync cần guard trạng thái/unique key khi được gọi lặp. AssignmentSearch được ghi cùng Accepted, notification enqueue cùng thay đổi nghiệp vụ; publish realtime sau commit.

## Migration và compatibility

- Tạo migration mới; không sửa migration đã áp dụng, không reset/truncate/drop dữ liệu. Các cột cũ được giữ trong giai đoạn chuyển tiếp.
- Preflight driver conflicts trước unique active-driver index. Deactivate assignment terminal có history lý do migration; unresolved multi-active trip phải fail có report, không chọn ngẫu nhiên một trip.
- Không backfill GPS/OTP/evidence giả hoặc dựng lịch sử stock chưa từng có. Ledger bắt đầu bằng opening balance ở cutover có barrier khóa ghi được kiểm chứng.
- Ghi manifest migration trong run: tên file, trạng thái applied trên schema test nào, rehearsal và preflight results. Không ghi URL/credential.
- Contract tightening phải cập nhật routes, UI, OpenAPI, fakes/fixtures và test có chủ đích. Không đổi enum/API shape âm thầm; định nghĩa error code cho transition/permission bị đổi.
- Giữ `/orders` array; endpoint monitoring/history có envelope riêng. Legacy fields dùng alias rõ nghĩa khi reporting thêm metric; không đổi meaning của revenue cũ.

## Dữ liệu và an toàn triển khai

- Không đọc/in secrets hoặc chỉnh `.env`; thêm cấu hình ở `.env.example` và documentation. Không tự commit/push/PR.
- Không lưu OTP plaintext, token, ảnh bytes hoặc raw GPS trong audit/log. Các stream chỉ gửi trường tối thiểu theo audience.
- Ảnh private, giới hạn dung lượng, kiểm tra type/signature, tên ngẫu nhiên và path không từ input; không serve bằng public/static path.
- Time filters nhận ISO UTC, khoảng `[from,to)`; UI chuyển ngày Asia/Saigon sang UTC. Tiền integer VND; null khác 0 đối với metric chưa có dữ liệu.

## Quality gates

Từ repo root, chạy những lệnh phù hợp task; file test mới trong phase là **đường dẫn dự kiến**, chỉ chạy khi đã tạo.

```powershell
npx tsx --test tests/module-boundaries.test.ts
npx tsc --noEmit
npm run check:openapi
npm run db:validate
npm run build
npm run format:check
npm test
npm run test:e2e
```

- Không có script lint trong baseline; không ghi `npm run lint` là đã chạy. Với thay đổi hẹp, bắt đầu targeted tests rồi mở rộng theo rủi ro.
- Tests DB dùng schema ngẫu nhiên và cấu hình test; xác nhận Prisma schema và pg search_path cùng trỏ schema đó. Không chạy migrate deploy lên database người dùng để “thử”.
- Redis test dùng connection/channel namespace riêng, timeout hữu hạn và finally cleanup; CI nghiệm thu phải có Redis thật và test không skip.
- Unit tests dùng injected clock, fake provider; race tests dùng PostgreSQL thật, barrier và nhiều request/transaction, không chỉ Promise giả lập hoặc kiểm tra tên hàm.
- UI giữ design system Bếp; loading/empty/error/retry, label/focus/keyboard, aria-live lỗi, touch target phù hợp; không chỉ toast hoặc màu đỏ. Kiểm tra 375/768/1024/1440 px và không overflow. SSE/GPS effects cleanup khi logout/chuyển role/unmount.
- Không chạy formatter toàn repo để sửa lệch ngoài task. Chỉ format file đã thay đổi; formatting debt có sẵn ghi riêng, không che kết quả check.

DONE yêu cầu mọi AC task có evidence; phase DONE yêu cầu tất cả task bắt buộc DONE, prerequisite hợp lệ và phase exit gate pass. Thiếu PostgreSQL/Redis/browser là BLOCKED/NOT_RUN, không suy ra business assertions pass. Tuân [state protocol](state/README.md).
