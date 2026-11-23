# Tasks

Các số invariant tham chiếu mục Invariants trong [thiết kế hệ thống](../../../../docs/design/design.md#invariants-và-chiến-lược-nhất-quán).

## 1. Nền web và luồng vào project

- [x] 1.1 Kiểm tra truy cập hai frame Figma hoặc bản export. Scaffold frontend, thiết lập kiểu sinh từ OpenAPI, rewrite cùng origin và catalog EN. Xác minh build, typecheck và sinh kiểu lặp lại được.
- [x] 1.2 Dựng đăng nhập, chọn workspace và project với giao diện dùng chung. Xử lý phiên hết hạn và dữ liệu riêng của phiên cũ (invariant 2, 14). Xác minh đăng nhập sai, đúng và truy cập lại URL đã bảo vệ.
- [x] 1.3 Chuẩn bị fixture và hướng dẫn chạy local trong repo frontend. Chạy với Redis thật để xác minh tài khoản demo đăng nhập qua origin frontend, mở đúng project và phiên đã thu hồi bị yêu cầu đăng nhập lại.

## 2. Đọc board và sửa nội dung task

- [x] 2.1 Dựng bốn cột Kanban theo thiết kế, render thứ tự API, mở chi tiết từ thẻ và hỗ trợ tải lại URL chi tiết. Xác minh thứ tự, dữ liệu có/không có người phụ trách và hạn chót (invariant 2, 4, 5).
- [x] 2.2 Dựng form sửa tiêu đề và Markdown, preview có sanitize, gửi version và header mutation theo contract. Xử lý xung đột giữ bản nháp và tải bản mới để đối chiếu. Kiểm tra sanitize, bản nháp và việc áp dụng lại chủ động (invariant 8, 17).
- [x] 2.3 Chạy với Redis thật qua web để xác minh sửa nội dung phản ánh trên thẻ, tải lại chi tiết vẫn giữ nội dung và hai phiên cùng sửa cho kết quả xung đột đã đặc tả (invariant 8, 17).

## 3. Kéo thả và nghiệm thu

- [x] 3.1 Triển khai kéo bằng chuột giữa các cột hợp lệ và sắp xếp trong cột. Cập nhật vị trí ngay khi thả, tuần tự hóa request theo task và xác minh payload neo ở đầu, giữa, cuối và cột rỗng (invariant 4, 5, 8, 17).
- [x] 3.2 Đồng bộ lại sau lỗi kéo thả, hiển thị lý do và xử lý mất phản hồi. Xác minh request ghi không tự phát lại, lỗi đọc lại có đường thử lại và không thể kéo lại thẻ khi kết quả chưa được đối chiếu (invariant 4, 5, 8, 17).
- [x] 3.3 Chạy demo desktop từ đăng nhập đến tải lại bằng Redis thật. Xác minh kéo sang cột khác vào giữa hai thẻ, sắp xếp trong cột, thứ tự sau reload và tối thiểu một lần backend từ chối với board được đồng bộ lại (invariant 2, 4, 5, 8, 17).

## 4. Đổi trạng thái trong Chi tiết task

- [x] 4.1 Thêm menu trạng thái dùng chung quy tắc với Kanban, gọi API move và giữ bản nháp. Kiểm tra lựa chọn hợp lệ, xung đột và thứ tự cột sau tải lại qua trình duyệt với Redis thật (invariant 4, 5, 8, 17).
