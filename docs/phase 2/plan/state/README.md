# Checkpoint và bàn giao

STATUS là trạng thái tổng hợp ngắn; TASKS là registry; HANDOFF là checkpoint tiếp tục gần nhất. Run lưu bằng chứng, incident lưu failure và các lần sửa. Không dùng transcript dài thay next action cụ thể.

## Vòng đời task

1. Trước sửa: kiểm Git/prerequisite/source; ghi IN_PROGRESS trong TASKS/STATUS và HANDOFF với next action, expected verification, user diff cần giữ.
2. Sau patch có ý nghĩa: ghi changed files, code state, phần còn dở trước khi mở subsystem khác.
3. Sau test: ghi exact command/exit/count/skip/môi trường redacted và AC chứng minh được vào run; cập nhật HANDOFF.
4. Nếu không tiếp tục an toàn vì lỗi/môi trường/policy/context, tạo incident rồi BLOCKED/INTERRUPTED; dừng task phụ thuộc.
5. Khi đủ mọi AC: link run, DONE, cập nhật next eligible task. Không tự chuyển phase ngoài phạm vi người dùng giao.

Không thể bảo đảm ghi sau ngắt cứng. Vì vậy checkpoint trước hành động và Git diff là nguồn phục hồi. Khi context sắp cạn, không mở task mới, ghi HANDOFF khi vẫn còn khả năng ghi.

## Trạng thái

- NOT_STARTED: chưa code task.
- IN_PROGRESS: đang làm, AC chưa đủ.
- INTERRUPTED: dừng do context/budget/session; code có thể dở.
- BLOCKED: không tiếp tục an toàn trong scope; cần incident + điều kiện unblock.
- DONE: đủ AC và verification bắt buộc.

Failure kind: CODE / ENVIRONMENT / POLICY / CONTEXT_BUDGET. Test result: NOT_RUN / PASS / FAIL / BLOCKED. Code state không chắc phải UNVERIFIED. Dùng thời gian thực tế ISO +07:00 khi có clock; không bịa giờ hoặc commit làm checkpoint.

## Tiếp tục

Đọc STATUS→HANDOFF→incident đang mở→phase. So HEAD/diff thật vì patch cuối có thể chưa ghi. Không xóa thay đổi lạ/reset. Xác minh migration đúng schema test. Bắt đầu bằng failing check tối thiểu hoặc health check được HANDOFF chỉ định, không full suite mù.

Task độc lập chỉ tiếp tục trong scope đã giao; phase có task BLOCKED không DONE. Policy đổi phải cập nhật DECISIONS/CONTRACTS và impact, không sửa AC để làm xanh status.

## Tên file

- Run: `runs/YYYYMMDD-HHMM-Pxx-Tyy.md`; incident: `incidents/YYYYMMDD-HHMM-Pxx-Tyy-short-reason.md`, suffix nếu trùng.
- Incident RESOLVED vẫn giữ các lần thử và link resolution run. HANDOFF giữ checkpoint mới nhất, lịch sử ở runs.
- Templates nằm trong README của hai thư mục; không chép secrets/connection strings/OTP/ảnh/GPS raw.
