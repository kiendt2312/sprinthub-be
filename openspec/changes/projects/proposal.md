## Why

US-19 cần một project trong tenant để team quản lý task và giữ được permalink khi dự án ngừng ghi. P0 cần hoàn thành vòng đời project trước khi mở task và board.

## What Changes

- Thêm API tạo, liệt kê, xem, sửa, archive và unarchive project cho workspace.
- Cấp key duy nhất theo workspace và khóa thay đổi key sau khi đã cấp issue number đầu tiên.
- Cho member đọc project archived. Mutation mới vào project archived bị chặn, với ngoại lệ unarchive và cleanup hệ thống. Replay hợp lệ vẫn trả kết quả cũ.

## Capabilities

### New Capabilities

- `projects`: CRUD vòng đời project, phân quyền, unique key và replay trong Redis.

### Modified Capabilities

## Impact

Đổi bổ sung ở OpenAPI v1, library Redis `sprinthub` và module HTTP. `tasks-and-board` dùng project JSON và kiểm archive trong các Function của mình.
