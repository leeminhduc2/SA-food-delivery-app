# Incident và lịch sử giải quyết

Chưa có incident triển khai ứng dụng. Lỗi dependency trong audit cũ là historical context; mở incident mới sau khi tái hiện ở phiên code. Tạo file theo [state protocol](../README.md), link từ STATUS/TASKS/HANDOFF; không chép secret/URL database/OTP/ảnh/GPS raw.

```markdown
# Pxx-Tyy lỗi ngắn gọn

- Status: OPEN | RESOLVED
- Kind: CODE | ENVIRONMENT | POLICY | CONTEXT_BUDGET
- Timestamp thực tế / branch / HEAD / user scope:
- Code state và files changed:
- AC bị chặn:
- Reproduction command / dependency / schema test redacted:
- Expected / actual / error excerpt đã loại dữ liệu nhạy cảm:

## Các lần thử

| Attempt | Giả thuyết | Hành động | Kết quả/evidence |
| ------- | ---------- | --------- | ---------------- |

## Vì sao dừng

Ghi giới hạn cụ thể và các task phụ thuộc phải dừng.

## Tiếp tục

- Điều kiện unblock:
- Next safe action và lệnh kiểm chứng tối thiểu:
- Thay đổi người dùng cần bảo toàn:
- Resolution/run link khi đã sửa:
```
