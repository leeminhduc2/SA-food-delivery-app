# Contract mục tiêu cho triển khai

Đây là specification cho code tương lai, không phải API/schema đã tồn tại. Khi triển khai, phase sở hữu phải cập nhật OpenAPI, UI/callers và behavior tests. HTTP paths có prefix `/api`. Chính sách và defaults nằm trong [DECISIONS](DECISIONS.md); lock order trong [ENGINEERING_RULES](ENGINEERING_RULES.md).

## C01 Quy ước chung và idempotency

- Giữ response/error legacy; endpoint mới dùng DTO camelCase, ISO UTC, integer VND, error `{code,message,requestId}`. Không serialize Prisma model nguyên dạng cho API mới.
- 401 chưa đăng nhập/inactive; 403 sai role/ownership; 404 không tồn tại; 400 validation; 409 transition/idempotency/eligibility conflict; 429 rate limit; 503 dependency lỗi. Auth trước dữ liệu private.
- Reason trim 3–300 ký tự, resolution support/refund tối đa 1000; audit không lưu token/OTP/ảnh/GPS raw.
- New retryable commands nhận `idempotencyKey` 8–120 ký tự, unique `(actorId,operation,resourceId,key)` + canonical fingerprint. Khác payload trả IDEMPOTENCY_CONFLICT; cùng payload trả result IDs/status đã ghi, không lặp side effect. Receipt commit cùng business transaction; reauthorize trước replay.
- Có thể thêm shared ActionReceipt repository chỉ cho command mới; không thay Order customer/key hoặc PaymentEvent. Không giữ bí mật trong receipt. Resource tạo mới dùng parent ID ổn định.
- Checkout tra key trước address/catalog/router. So fingerprint legacy bằng `old.address` cùng request items/note/expectedTotal, không lấy default address mới. Retry trả order cũ dù default address đổi/xóa; key mới vẫn check lại trong advisory-lock transaction sau preview.
- Pagination mới `{items,nextCursor}`, limit default 25/max 100, cursor opaque với stable sort. `/orders` giữ array. Time filter `[from,to)` ISO UTC, invalid trả 400.

## C02 Ownership và persistence

| Owner               | Model/field mục tiêu                 | Constraint/dữ liệu                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Assignment          | DriverAvailability                   | Một row/driver: online, ready, heartbeatAt, version. Busy derive từ Delivery, không lưu làm nguồn thứ hai.                                                                                                                                             |
| Assignment          | AssignmentSearch                     | deliveryId, generation, status, strategy, round, offersCreated, deadlineAt, nextRunAt, leaseOwner/Until, version; unique delivery/generation và một search live/delivery.                                                                              |
| Assignment          | DriverOffer                          | searchId, driverId, status, expiresAt, respondedAt, assignmentId optional; partial unique OFFERED/driver và OFFERED/search.                                                                                                                            |
| Assignment          | AssignmentAttempt                    | searchId/driverId/round/rank/criterion/offerId/outcome/reason/time; unique search/driver. INELIGIBLE attempt không cần offer.                                                                                                                          |
| Assignment          | DriverOperationalChange              | Durable pending invalidation driverId/source/changeId với due/lease/attempts; unique changeId. Availability có observedVersion, account dùng changeId mới mỗi thay đổi thực; worker luôn đọc trạng thái hiện tại, không áp lại trạng thái cũ từ event. |
| Delivery            | DriverAssignment hiện có             | active=occupancy; endedAt/endReason và assignment snapshot cho history; thêm unique active/driver cạnh active/delivery.                                                                                                                                |
| Delivery            | Delivery hiện có                     | arrivedAt/pickedUpAt/inTransitAt/deliveredAt/failedAt và proofRequired snapshot; không tạo confirmed Assignment song song.                                                                                                                             |
| Location            | DriverLocation                       | Latest một row/driver: latitude/longitude/capturedAt/receivedAt/version; không append trajectory.                                                                                                                                                      |
| Catalog             | Restaurant/MenuItem                  | phone có sẵn; thêm structured openingSchedule/timezone; lowStockThreshold optional. stock vẫn authoritative.                                                                                                                                           |
| Catalog             | StockMovement                        | item/kind/delta/balanceAfter/actor/reason/order optional/operationKey/time; kind OPENING, ADJUSTMENT, RESERVE, RELEASE; unique business operation.                                                                                                     |
| Delivery            | DeliveryProofChallenge/DeliveryProof | OTP salt/hash/expiry/attempts, assignmentId, method/status, storage key/evidence metadata; không plaintext/public URL.                                                                                                                                 |
| Delivery            | DeliveryIncident                     | delivery/order/type/status/reason/evidence refs/resolution/history; unique incident OPEN theo delivery/type.                                                                                                                                           |
| Support             | Complaint mở rộng                    | reporterId/reporterRole/history backfill từ customer_id; customer_id cũ nullable cho non-Customer mới, giữ alias cho Customer legacy; cập nhật reader trước enable staff ticket, không tạo SupportTicket song song.                                    |
| Review              | ReviewReply/ReviewModerationRequest  | Một reply hiện hành/review/Restaurant với revision history; moderation request/decision có reason/history.                                                                                                                                             |
| Payment             | RefundRequest                        | order/payment, source incident/complaint/cancel, full amount, decision/status/reference/attempts/nextRun/error; một operation approved/pending hiệu lực/payment.                                                                                       |
| Delivery            | DriverEarningEstimate                | Unique delivery, finalDriverId, deliveryFee snapshot, VND, deliveredAt, basis SIMULATED_ESTIMATE.                                                                                                                                                      |
| Shared/Notification | AuditLog/Outbox                      | Audit resourceType/outcome/correlationId nullable, legacy UNKNOWN. New deduplicated outbox events use a stable recipient/type/business-key hash as their primary ID; existing random IDs stay valid.                                                   |

Partial indexes/CHECK nằm trong migration SQL và được test. Không backfill dữ liệu lịch sử thiếu bằng giá trị giả. Migration mới có preflight/cutover theo từng phase.

## C03 State machines, events và worker

- Order giữ enum: Restaurant CONFIRMED→ACCEPTED→PREPARING→READY_FOR_PICKUP; reject chỉ CONFIRMED→CANCELLED với action/reason riêng. Refund delivered không đổi state Order.
- Delivery giữ UNASSIGNED→ASSIGNED→PICKED_UP→IN_TRANSIT→DELIVERED; FAILED từ PICKED_UP/IN_TRANSIT có reason. ARRIVED là timestamp trên ASSIGNED, không state mới. Terminal đóng assignment cùng transaction; không restock sau pickup.
- Search WAITING→SEARCHING→OFFERED; accept→ASSIGNED, reject/expire/revoke→SEARCHING hoặc WAITING vòng sau; cap/deadline→EXHAUSTED, Order không hợp lệ→CANCELLED. Admin retry tạo generation mới, không mở search terminal.
- Offer OFFERED→ACCEPTED/REJECTED/EXPIRED/REVOKED. Attempt ghi outcome một lần. Mỗi candidate xét tối đa một lần/generation; tổng offer<=10, tối đa 3 vòng. Hết danh sách thì refresh candidates sau backoff; không mời lại candidate đã có attempt.
- Worker reuse runBackgroundCycle, batch 50, lease 30s, version/CAS revalidation sau network; release lease sau offer creation, nextRun theo expiresAt. Không giữ lock khi gọi provider. Lỗi một loại job không làm starvation payment/assignment/notification khác.

| Event                             | Publisher → subscriber                            | Semantics                                                                                                               |
| --------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| OrderAccepted                     | Ordering → Assignment                             | `{orderId,deliveryId,actor}`; handler sync ghi search generation đầu trong transaction Accepted; unique/idempotent.     |
| DriverEligibilityChanged          | Identity/Assignment → Assignment                  | `{driverId,changeId,source:'ACCOUNT'                                                                                    | 'AVAILABILITY',reason,observedVersion?}`; handler chỉ ghi operational work, không khóa Order ngược chiều; source/version khác nhau không dùng chung counter. |
| DeliveryPickedUp/Completed/Failed | Delivery → Ordering và subscribers cần thiết      | Giữ payload cũ; handler mới guard version/state. Failure có incident tối thiểu từ P05; P11 bổ sung resolution workflow. |
| AssignmentConfirmed/Exhausted     | Assignment → notification/application subscribers | IDs/generation/status, recipient-specific payload; không full customer PII cho ứng viên.                                |

Dùng bus sync hiện có. Search là durable work item, notification outbox vẫn dành cho notification. Queue notification cùng business transaction, realtime publish sau commit, lost push khôi phục từ snapshot. Không tạo broker/event bus song song.

## C04 Driver availability, GPS và offers

| Endpoint                       | Body/actor                               | Kết quả/guard                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /driver/availability       | DRIVER                                   | `{online,ready,busy,heartbeatAt,locationFresh,version}` của mình.                                                                                                               |
| PATCH /driver/availability     | DRIVER `{online?,ready?}`                | Online cần fresh GPS; offline khi busy trả ACTIVE_DELIVERY; ready=false được phép, thu hồi offer chờ nhưng không thu hồi chuyến active.                                         |
| POST /driver/heartbeat         | DRIVER                                   | Server heartbeat; không đổi capturedAt GPS.                                                                                                                                     |
| POST /driver/location          | DRIVER `{latitude,longitude,capturedAt}` | `{capturedAt,receivedAt,version}`; active account có thể gửi cả khi chưa assigned/offline để chuẩn bị online; age<=90s, future<=15s, update newer, min interval 5s.             |
| GET /driver/offers             | DRIVER                                   | `{items}` chỉ OFFERED của mình chưa hết hạn.                                                                                                                                    |
| POST /driver/offers/:id/accept | DRIVER `{idempotencyKey}`                | `{offerId,assignmentId,deliveryId,status}`; lock/revalidate Order ACCEPTED/PREPARING/READY, Delivery open, Driver active/online/ready/fresh/not busy, offer/generation current. |
| POST /driver/offers/:id/reject | DRIVER `{reason,idempotencyKey}`         | `{offerId,status:REJECTED}`; attempt + wake next + audit cùng transaction.                                                                                                      |

Offer trước accept chỉ có pickup name/address/coordinates, deliveryFee, deadline và walking approach nếu có. Không địa chỉ khách, note hoặc món chi tiết. Sau accept trip DTO có pickup/dropoff, snapshot món, note, delivery fee; không full Payment record.

GPS error: STALE_LOCATION, LOCATION_OUT_OF_ORDER, LOCATION_RATE_LIMITED; eligibility 409: OFFER_EXPIRED, OFFER_NOT_ACTIVE, DRIVER_OFFLINE, DRIVER_NOT_READY, DRIVER_BUSY, ORDER_NOT_ASSIGNABLE. Foreign offer 403 trước khi tiết lộ trạng thái.

## C05 History, tracking và Admin

- `/orders` Driver gồm current active và terminal trip mà họ là final Driver. Reassigned-away chỉ đọc metadata assignment mình, không địa chỉ khách/note/payment/GPS mới.
- GET `/driver/deliveries/history`: envelope assignmentId/deliveryId/restaurantName/assignedAt/endedAt/result/finalDriver; revoked record redacted. Terminal detail chỉ final Driver đọc snapshot theo quyền; không live GPS sau terminal.
- POST `/deliveries/:id/arrive`: DRIVER current `{idempotencyKey}`, ghi arrivedAt một lần khi ASSIGNED; pickup vẫn cần ready. Customer/Restaurant xem mốc đến quán.
- GET `/orders/:id/tracking`: `{orderId,deliveryId,status,driver,location,routeMode:'WALKING',capturedAt,stale}`; chưa assigned/terminal location=null + reason.
- GET `/orders/:id/tracking/stream`: SSE location/tracking_status/revoked/heartbeat. Authorize actor/order/current assignment lúc subscribe và trước push; revalidate session/account. Terminal/reassign/revocation dừng stream; heartbeat tối đa 5s phát hiện mất quyền khi invalidation push mất. Không replay trajectory.
- Nối TrackingAccessGateway do Ordering/composition root implement; Location không import Ordering gây cycle. Tái sử dụng Redis lifecycle với typed tracking topic; không broadcast GPS cho tất cả client. Redis lỗi fallback GET DB snapshot 15s vẫn kiểm quyền.

| Admin API                                      | Input                                             | Quy tắc                                                                                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /admin/assignments, /admin/assignments/:id | status/driverId/restaurantId/from/to/cursor/limit | P05 minimal list/detail đủ core observability; P07 thêm filters/pagination, attempt history/UI.                                                                         |
| GET /admin/orders, /admin/deliveries           | status/restaurant/driver/time filters             | Envelope stable createdAt,id desc; không đổi /orders legacy.                                                                                                            |
| POST /admin/assignments/:id/retry              | `{reason,idempotencyKey}`                         | EXHAUSTED hoặc operational incident trước pickup; generation mới, không bỏ eligibility.                                                                                 |
| POST /admin/deliveries/:id/reassign            | `{driverId,reason,exceptionCode,idempotencyKey}`  | NO_DRIVER/DRIVER_UNAVAILABLE/OPERATIONAL_ERROR; có incident/exhaustion hoặc tạo incident cùng command. Revoke old offers/assignment và assign atomic; không sau pickup. |
| POST /deliveries/:id/assign legacy             | Từ P05 cùng body/policy reassign                  | Alias, không bypass thiếu reason. P02–P04 tạm giữ driverId body nhưng vẫn capacity guard.                                                                               |
| PATCH /admin/users/:id                         | `{active,reason}`                                 | Giữ endpoint, thêm reason/invalidation; không tự khóa mình.                                                                                                             |

P05 phải có reason-gated override, minimal monitoring và alerts; không đợi P07 mới đáp ứng core gate. Account lock trước pickup invalidates/retry sau commit; sau pickup giữ trip/occupancy, tạo incident cho Admin kết thúc FAILED theo exception policy.

## C06 Catalog, menus và giờ mở cửa

Restaurant create/patch thêm phone nullable, openingSchedule nullable; timezone Asia/Saigon. Giữ opening_hours free text cũ display-only. Schedule gồm 7 phần tử `{day:0..6,intervals:[{start:'HH:mm',end:'HH:mm'}]}`, 0=Sunday; max 4 interval/day, start<end, không overlap. Chỉ end được phép24:00; start không được24:00. Ca qua đêm tách hai ngày; không auto parse legacy text. Null schedule giữ hành vi cũ. Quote/checkout dùng DB now; manual pause/hidden/not-approved luôn chặn; đóng theo lịch trả RESTAURANT_CLOSED.

- GET/POST `/restaurants/:id/menus`; POST `{name}` trim 1–60, unique case-insensitive trong restaurant. PATCH `/menus/:id` `{name}`. DELETE chỉ nhóm không có item kể cả archived, nếu còn MENU_NOT_EMPTY; move items trước khi xóa. Rename không sửa order snapshot.
- Chỉ Restaurant member ghi profile/menu/giá. Admin có POST `/admin/restaurants/:id/suspend` `{reason,idempotencyKey}` để hide/pause vi phạm, không sửa giá. Approval cũ giữ, rejection yêu cầu reason.
- POST `/orders/:id/reject` RESTAURANT member `{reason,idempotencyKey}`, chỉ CONFIRMED; tái sử dụng cancel/refund/stock contracts, action RESTAURANT_REJECTED; không thêm Order REJECTED.

## C07 Inventory

- POST `/items/:id/stock-adjustments` RESTAURANT member `{delta,reason,idempotencyKey}`, integer delta khác 0, kết quả không âm; trả `{movementId,stock,balanceAfter}`. GET `/items/:id/stock-movements` paginated, member/Admin audit view.
- UI dùng delta command. Legacy PATCH item stock chỉ chấp nhận cùng stockReason/idempotencyKey: khóa row, đổi target thành delta, dùng cùng ledger; stock không đổi không movement. Thiếu fields khi đổi stock trả STOCK_ADJUSTMENT_REQUIRED; không âm thầm bỏ input.
- Opening balance một lần/item ở cutover; create item có opening. Reserve delta âm, release delta dương unique order-item-operation. DELIVERED không trừ stock lần hai. Rollback nghiệp vụ rollback ledger/alert.
- Alert khi crossing >threshold xuống <=threshold (default5); lên trên threshold rearm. stock=0 trả sellable=false/unavailableReason; không đổi manual available/visible. Không thêm nguồn tồn thứ hai.

## C08 OTP, photo và proof requirement

- POST `/orders/:id/delivery-proof/otp`: CUSTOMER owner `{idempotencyKey}` khi PICKED_UP/IN_TRANSIT; trả challengeId/otp/expiresAt. OTP 6 digits hash+random salt; plaintext chỉ trả lần tạo, không vào DTO Order/Driver/log/notification/receipt. Retry key cũ trả challengeId/expiresAt/otp:null; regenerate key mới revoke challenge cũ. Rate3 challenge/10 phút/order.
- POST `/deliveries/:id/proofs/otp`: DRIVER current `{challengeId,otp,idempotencyKey}`. TTL10 phút, max5 attempts; cập nhật failed attempt atomic ngay cả khi response lỗi. Same key retry không tăng attempts; challenge cũ/replay từ assignment khác bị từ chối.
- POST `/deliveries/:id/proofs/photo`: DRIVER current, raw binary Content-Type image/jpeg hoặc image/png, X-Idempotency-Key, <=5MB. Route dùng raw parser cho image media types, không đưa ảnh qua JSON parser; giữ authentication/CSRF middleware hiện có. Kiểm magic bytes, random storage key, private path. Trả `{proofId,method:PHOTO,status:VERIFIED}` sau file validation; VERIFIED không phải AI xác thực cảnh trong ảnh.
- GET `/deliveries/:id/proofs/:proofId/content`: Customer owner/Restaurant member/current-final Driver/Admin đúng resource; Cache-Control private,no-store. Không static/public URL hoặc trả server path.
- DELIVERED transition yêu cầu một proof VERIFIED của current assignment nếu proofRequired snapshot=true. OTP hoặc photo đều đủ. Legacy snapshot=false không bị chặn; chỉ delivery mới từ cutover nhận default true.
- File staging/orphan cleanup: DB commit lỗi thì xóa file vừa tạo hoặc persist cleanup work; không trả fake content khi file thiếu. Giữ ảnh30 ngày sau terminal, legal hold khi complaint/incident mở; purge bytes giữ metadata/audit. Local single-instance demo, production storage deferred.

## C09 Support, review và incident/refund

- Complaint endpoints mở CUSTOMER/RESTAURANT/DRIVER theo order ownership/membership/assignment. Reporter chỉ own ticket; Admin tất cả. Driver revoked có thể gửi complaint về assignment từng tham gia nhưng không nhận thêm PII từ API ticket. Backfill reporterId/reporterRole và giữ customer_id alias legacy.
- POST/PUT `/reviews/:id/reply`: Restaurant member `{content,idempotencyKey}`, 3–1000 chars; một reply hiện hành, append revisions. Không sửa/xóa review gốc.
- POST `/reviews/:id/moderation-requests`: member `{reason,idempotencyKey}`. Admin PATCH `/admin/review-moderation-requests/:id` `{decision:APPROVE|REJECT,reason,idempotencyKey}`; approved hide qua Review service, evidence/history giữ nguyên. Existing hide/unhide bổ sung reason.
- DeliveryFailed tạo incident/audit/Admin notification một lần. Incident OPEN→RESOLVED với resolution REFUND_REQUESTED/NO_REFUND/NO_ACTION + reason. POST `/admin/deliveries/:id/fail` chỉ PICKED_UP/IN_TRANSIT với incident operational và reason/key; không thay Driver trong happy path. Không redelivery/restock sau pickup.
- POST `/orders/:id/refund-requests`: Customer owner/Admin `{complaintId?,incidentId?,reason,idempotencyKey}`. DELIVERY_FAILED cần incident; DELIVERED cần complaint đúng order; CANCELLED theo auto-flow cũ, không ép Admin approve lại. Restaurant/Driver gửi support, không refund tiền khách.
- POST `/admin/refund-requests/:id/decision`: `{decision:APPROVE|REJECT,reason,idempotencyKey}`. Amount=Payment.amount snapshot immutable. REQUESTED→APPROVED/REJECTED; APPROVED→PROCESSING→SUCCEEDED hoặc FAILED sau cap.
- Approval ghi Payment REFUND_PENDING + durable reference/work cùng transaction. Worker gọi simulator ngoài transaction, query khi outcome chưa rõ trước retry. Provider xác nhận mới REFUNDED. 5 attempts/backoff30/60/120/240s; hết lượt request FAILED, payment vẫn REFUND_PENDING/reconciliation_required; Admin retry có reason/key. Không báo đã refund khi chưa xác nhận.
- Một stable refund reference/payment, dùng chung auto-cancel/late-payment queue và manual approval; không hai operation trả tiền song song. Refund không tự resolve complaint, không đổi Order DELIVERED, không xóa Driver estimate.

## C10 Reports và strategies

GET `/restaurants/:id/reports`, `/driver/reports`, `/admin/reports`: time filter/role scope, trả basis/timezone/coverage; thiếu timestamp legacy trả null + coverage count, không dùng createdAt thay mốc nghiệp vụ.

- Gross delivered order value=sum total DELIVERED gồm ship, giữ alias revenue cũ; merchandise value=sum subtotal, không gọi payout.
- Refunded amount theo refund-confirmed time; tách cohort/basis khỏi delivery time, không tự lấy hai số khác cohort trừ thành net.
- Driver estimatedEarnings snapshot deliveryFee, unique delivery/final Driver theo deliveredAt; failed/cancel không tính, customer refund không trừ. Backfill chỉ khi final Driver xác định được.
- Success rate=delivered/(delivered+failed) theo terminalAt; mẫu số0 trả null. Average delivery=deliveredAt-pickedUpAt của records đủ mốc; prep=readyAt-acceptedAt, assignment wait=assignedAt-acceptedAt.
- Online=account active+online+heartbeat fresh; ready tách riêng; pending assignment=live search chưa assigned. Không lấy số notification làm KPI nghiệp vụ.

AssignmentStrategy `rank(context,candidates): Promise<RankedDriver[]>` không write/assign; trả permutation đủ candidate IDs đầu vào, không thêm/bỏ/trùng; deterministic tie Driver ID, typed criterion/routeMode/fallbackReason/rankingScope. Worker vẫn revalidates.

- NEAREST: Haversine tới pickup, tie ID; không giả quãng đường đi bộ.
- LOWEST_ETA: top5 nearest eligible, query pedestrian ETA qua port timeout/concurrency; đủ route thì top5 theo ETA, tie distance/ID, phần còn lại theo Nearest với ETA null và rankingScope TOP5_NEAREST. Nếu top5 có route lỗi/thiếu, fallback toàn tập NEAREST có reason, không ETA=0; không tuyên bố nhanh nhất toàn bộ vùng.
- BALANCED_LOAD: số chuyến đã pickup trong24h tăng dần, rồi Haversine, Driver ID; cửa sổ [now-24h,now]. Delivery public query cung cấp count/coverage; gồm failed đã pickup, loại cancel trước pickup. Thiếu history cần thiết thì fallback Nearest có reason, không bịa observed0. Không dùng active count luôn0 của Driver rảnh.

## C11 Resilience

Breaker per provider/process: 5 consecutive network/timeout/5xx → OPEN30s → HALF_OPEN một probe → CLOSED khi success, OPEN lại khi lỗi. 4xx/validation nghiệp vụ không trip. Read/query có thể retry2 lần backoff250/500ms+jitter<=100ms trong request budget; không retry mù lệnh tiền. Create/refund dùng stable reference+query, chỉ bảo đảm trên simulator đã test; provider thật deferred.

Transport loss không chặn DB commit; UI fallback cả khi EventSource còn CONNECTING. Persist backlog/retry/error để Admin theo dõi. Metrics local không chứng minh production SLO. Nghiệm thu đủ ở P14.
