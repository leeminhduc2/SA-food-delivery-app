# Hạng mục ngoài phạm vi demo đã chốt

Deferred có chủ đích, không phải đã hoàn thành. P14 giữ status DEFERRED trong coverage. Terra không tự chọn provider hoặc chuyển sang tiền thật.

| ID    | Hạng mục                             | Demo có                                                             | Điều kiện mở triển khai thật                                                                                                                  |
| ----- | ------------------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| EXT01 | Payment/refund provider thật         | Simulator, provider port, stable reference/reconcile/contract tests | Người dùng chọn provider/sandbox, có spec create/query/refund/webhook/idempotency, credential ngoài repo và policy settlement/fees/phê duyệt. |
| EXT02 | Payout/thu nhập thực nhận            | Estimate100% deliveryFee snapshot có nhãn                           | Chốt hợp đồng/commission/cycle/refund allocation và provider chi tiền.                                                                        |
| EXT03 | Photo storage production             | Private local ProofStorage port/access/retention                    | Chọn object storage, credential, signed access, encryption/retention, multi-instance consistency/backup.                                      |
| EXT04 | Routing xe máy                       | Pedestrian route/ETA/fees                                           | Chọn mode/provider hỗ trợ; đánh giá pricing/cache/migration/tests.                                                                            |
| EXT05 | Redelivery sau pickup/partial refund | Failure incident và full-refund decision                            | Người dùng hiện chọn không làm; mở lại cần policy/schema attempts và phân bổ tiền mới.                                                        |
| EXT06 | Production SLO/DR/đa vùng            | Local metrics/health/resilience/runbook                             | Có traffic/SLO/RPO/RTO/retention/hạ tầng; load local không chứng nhận production.                                                             |

Khi mở mục deferred, tạo phase mới với decisions/contracts/migration/AC riêng và cập nhật coverage. Các port hiện có phải hỗ trợ thay adapter mà không viết lại domain.
