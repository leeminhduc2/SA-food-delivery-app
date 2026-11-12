# Run evidence

Run lưu kiểm chứng thực tế cho task, gồm cả fail/skip. PLAN-AUTHORING chỉ kiểm tài liệu, không nghiệm thu code. Không ghi pass suy đoán; không thay acceptance bằng transcript.

```markdown
# Run Pxx-Tyy

- Timestamp / branch / HEAD / phạm vi:
- Source diff / fake provider / schema test / Redis namespace / browser redacted:
- Migration tên/status/rehearsal:

| Command | Exit | Test/result count | PASS/FAIL/BLOCKED/NOT_RUN |
| ------- | ---- | ----------------- | ------------------------- |

## Acceptance evidence

| AC ID | Kịch bản | Assertion/evidence | Kết quả |
| ----- | -------- | ------------------ | ------- |

## Giới hạn và tiếp tục

- Checks chưa chạy/skip và lý do:
- Incident link:
- Code state sau run:
- Next safe action:
```
