# Proposal

## Why

Demo Kanban hiện cần tài khoản, workspace và project đã chuẩn bị. Người dùng mới cần tự đi từ đăng ký đến task đầu tiên bằng giao diện web.

## What Changes

- Thêm đăng ký từ màn đăng nhập. Sau phản hồi chấp nhận, mở lại màn đăng nhập với email điền sẵn và thông báo trung tính.
- Thêm form tạo workspace và project vào các trang danh sách hiện có. Gợi ý slug và mã project từ tên, cho phép sửa.
- Thêm form tạo task chỉ cần tiêu đề trên board. Khi tạo thành công, đóng form và đưa tiêu điểm đến thẻ mới trong To do.
- Giữ dữ liệu form khi lưu lỗi. Khi kết quả chưa rõ, cho phép người dùng chủ động thử lại cùng thao tác khi form còn mở.

## Capabilities

### New Capabilities

Không có.

### Modified Capabilities

- `web-task-board` — Người dùng web có thể đăng ký và tự tạo workspace, project, task để bắt đầu sử dụng Kanban.

## Impact

OpenSpec nằm ở `sprinthub-be`. Form, thông báo và bài kiểm tra trình duyệt nằm ở `sprinthub-ui`. Luồng dùng các API và kiểu OpenAPI hiện hành. Quản lý thành viên, chỉnh thuộc tính task và mở rộng ngôn ngữ toàn app thuộc các lát cắt P0 riêng.
