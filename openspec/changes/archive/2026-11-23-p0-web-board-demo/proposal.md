# Proposal

## Why

SprintHub đã có API cho workspace, project, task và Kanban. Bản demo web đầu tiên đưa hai màn Figma đã duyệt vào một luồng chạy với backend thật để kiểm tra thao tác sửa task và kéo thả từ đầu đến cuối.

## What Changes

- Dựng frontend desktop bằng tiếng Anh, dùng tài khoản, workspace và project có sẵn. Người dùng đăng nhập, chọn workspace và mở board của project.
- Dùng hai frame UI Study trong Figma làm chuẩn cho Kanban và Chi tiết task. Các màn dẫn vào demo dùng chung phong cách.
- Hiển thị task thật và cho sửa tiêu đề, mô tả Markdown và chuyển trạng thái từ Chi tiết task. Ưu tiên, người phụ trách và hạn chót hiển thị từ API.
- Hỗ trợ chuyển task giữa các cột hợp lệ và sắp xếp trong cùng cột bằng chuột. Cập nhật ngay khi thả và đối chiếu dữ liệu khi thao tác bị từ chối hoặc kết quả lưu chưa rõ.
- Giữ bản nháp khi lưu chi tiết gặp xung đột. Nghiệm thu dữ liệu và thứ tự sau tải lại.
- Các lát cắt sau xử lý đăng ký, khởi tạo workspace và project, tạo/xóa task, sửa các thuộc tính khác, chuyển ngôn ngữ, thao tác trên mobile và admin console theo roadmap.

## Capabilities

### New Capabilities

- `web-task-board` — Luồng web từ đăng nhập đến xem, sửa và sắp xếp task trên board của project.

### Modified Capabilities

Không có.

## Impact

OpenSpec nằm ở `sprinthub-be`. Mã ứng dụng sẽ nằm ở `sprinthub-ui`, repo GitHub `sprinthub-fe`. Demo dùng API và OpenAPI hiện hành của backend với Redis thật ở local.
