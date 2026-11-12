# Bàn giao ban đầu cho GPT 6.1 Terra

Checkpoint khởi tạo ngày 12/11/2026, không phải code dở dang.

## Đã thực hiện

- Soạn bộ kế hoạch và cơ chế checkpoint theo scope demo đã chốt.
- Không code ứng dụng; tất cả task NOT_STARTED. Không migration/API/.env/commit/push.
- Baseline lúc soạn: feat/notification-sse, acbb8df; docs/phase 2/ untracked. Phải kiểm lại trước sửa.

## Tiếp tục tại P00-T01

Đọc [README](../README.md), [STATUS](STATUS.md), [P00](../phases/P00-baseline-and-execution.md), rồi chạy từ repo root:

```powershell
git status --short
git branch --show-current
git log -1 --format='%h %s'
```

Đối chiếu source/scripts với plan. Tạo run và cập nhật IN_PROGRESS trước hành động triển khai. Không đánh dấu P00 xong vì tài liệu đã có.

Ứng dụng chưa được test lại trong phiên soạn. Audit cũ không kết nối được PostgreSQL/Redis; kiểm health có timeout, không in secrets/tự sửa .env. DB tests phải schema riêng. Test file mới trong phases là mục tiêu, chưa có ở baseline.

## Template cập nhật sau này

Giữ checkpoint ngắn; logs đầy đủ chuyển run/incident.

```text
Timestamp thực tế / branch / HEAD / user scope:
Phase-task status / last DONE:
Git diff và thay đổi người dùng cần giữ:
Files đã sửa, hành vi và phần còn dở:
AC pass (ID + evidence), AC chưa đạt/chưa kiểm:
Code state: VERIFIED | UNVERIFIED | BUILD_FAILING | TEST_FAILING
Commands/results + run links:
Migration names/status/schema test redacted:
Blocker kind + incident link:
Các cách đã thử và vì sao không lặp lại:
Next safe action (file/use case/command cụ thể):
Điều kiện task/phase DONE:
```
