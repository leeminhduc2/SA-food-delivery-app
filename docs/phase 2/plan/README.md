# Kế hoạch triển khai SA Food Delivery cho GPT 6.1 Terra

Bộ tài liệu này chuyển các khoảng trống trong [audit](../IMPLEMENTATION_STATUS_AUDIT.md) thành 15 phase P00–P14, gồm 46 task có điều kiện nghiệm thu và quy trình tiếp tục qua nhiều phiên. Đây là kế hoạch triển khai bản demo đã được người dùng chốt ngày 12/11/2026; việc tạo tài liệu không có nghĩa source ứng dụng đã triển khai các phase.

Baseline khi soạn: nhánh `feat/notification-sse`, HEAD `acbb8df`. Mọi phiên code phải kiểm tra lại Git và source thực tế. Không coi baseline này là bảo đảm working tree chưa thay đổi.

## Đọc trước khi code

1. [Trạng thái hiện tại](state/STATUS.md), [bàn giao](state/HANDOFF.md), [task registry](state/TASKS.md).
2. [Roadmap và dependency](ROADMAP.md); chọn đúng phase được người dùng giao.
3. [Các quyết định](DECISIONS.md), [quy tắc engineering](ENGINEERING_RULES.md), các mục liên quan trong [contracts](CONTRACTS.md).
4. File phase tương ứng trong `phases/`; đọc source được liệt kê trước khi sửa.
5. [Coverage matrix](COVERAGE_MATRIX.md) và incident đang mở; không đọc toàn bộ lịch sử run nếu không liên quan task hiện tại.

Nguồn thiết kế: [master prompt](../SA_Food_Delivery_AI_Coding_Master_Prompt.md), [DOCX kiến trúc và role](../SA_Food_Delivery_Architecture_and_Role_Design.docx). Các quyết định người dùng đã chốt trong DECISIONS được ưu tiên khi tài liệu cũ khác nhau. Không tự mở lại câu hỏi đã có đáp án.

## Phạm vi được chốt

- Giữ React/TypeScript, Express, PostgreSQL/Prisma, Redis tùy chọn cho realtime và Modular Monolith.
- Hoàn thiện automatic assignment, tracking, role workflows, inventory, proof, support/refund simulator và reports. P05 là core gate; P14 là nghiệm thu toàn bộ demo.
- Restaurant sở hữu menu/giá; Admin chỉ quản trị, kiểm duyệt và can thiệp ngoại lệ có audit.
- Routing đi bộ; earning chỉ là ước tính; refund toàn phần theo approval. OTP hoặc ảnh đều có thể chứng minh giao hàng.
- Provider thật, payout thật, storage production và giao lại sau pickup nằm trong [deferred](DEFERRED_EXTERNALS.md).

## Đơn vị làm việc

Mỗi task có ID ổn định, ví dụ `P05-T02`; task có prerequisite nội bộ ghi trong file phase. Thứ tự mặc định là P00→P14, nhưng chỉ code các phase người dùng đã giao. Không bắt đầu task phụ thuộc BLOCKED/INTERRUPTED. Một phiên được giao cả phase có thể làm các task liên tiếp khi còn đủ context, nhưng phải checkpoint giữa các task.

Không làm lại chức năng đã có chỉ để đổi tên entity. Tái sử dụng DriverAssignment, StateHistory, Complaint, notification outbox và public APIs. Schema/API trong CONTRACTS là mục tiêu, không phải khẳng định đã tồn tại.

## Prompt bắt đầu cho Terra

```text
Triển khai phase P00 theo docs/phase 2/plan/README.md.
Đọc state/STATUS.md, state/HANDOFF.md và file phase trước; kiểm tra Git/source thực tế.
Chỉ làm phase được giao. Tuân DECISIONS, ENGINEERING_RULES và CONTRACTS.
Trước mỗi task ghi checkpoint IN_PROGRESS; sau thay đổi/test cập nhật evidence.
Không sửa .env, reset database, commit hoặc push. Không ghi đè thay đổi người dùng.
Nếu bị chặn hoặc sắp hết context, ghi incident/HANDOFF trước khi dừng.
Kết thúc bằng task đã đạt AC, test thực tế, blocker và ID task tiếp theo.
```

Với phase khác, thay P00 bằng ID được giao; không bỏ qua prerequisite chỉ vì prompt đổi ID.

## Prompt tiếp tục sau gián đoạn

```text
Tiếp tục phạm vi phase đã được giao theo docs/phase 2/plan/README.md.
Đọc state/STATUS.md, state/HANDOFF.md, incident đang mở và phase/task hiện tại.
Đối chiếu Git diff với checkpoint: không mặc định thao tác cuối đã được ghi.
Xác nhận trạng thái migration và chạy lại kiểm tra tối thiểu được HANDOFF chỉ định.
Không lặp lại cách sửa đã thất bại nếu không có giả thuyết mới và bằng chứng.
Giải quyết blocker hoặc tiếp tục task đủ prerequisite; cập nhật checkpoint/evidence.
Không đánh dấu DONE nếu thiếu AC hoặc test bị chặn bởi môi trường.
```

## Cách bàn giao và nghiệm thu

Dùng quy trình/template trong [state](state/README.md). Trước khi token/context cạn, ưu tiên ghi trạng thái thật và bước kế tiếp; không đợi sau khi bị ngắt mới ghi chú. Không cam kết có thể ghi sau một lần ngắt cứng: checkpoint trước thay đổi và Git diff là cơ chế phục hồi.

DONE yêu cầu đầy đủ AC, kiểm chứng phù hợp và liên kết evidence. Test không chạy được phải ghi BLOCKED/NOT_RUN; không dùng test pass của lần audit làm bằng chứng cho source vừa sửa. Chưa có phase ứng dụng nào được đánh dấu DONE khi khởi tạo bộ tài liệu.
