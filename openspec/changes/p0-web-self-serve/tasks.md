# Tasks

Các số invariant tham chiếu [thiết kế hệ thống](../../../docs/design/design.md#invariants-và-chiến-lược-nhất-quán).

## 1. Đăng ký và đăng nhập

- [x] 1.1 Thêm liên kết và form đăng ký. Khi API chấp nhận, chuyển tới đăng nhập với email điền sẵn, thông báo trung tính và mật khẩu trống. Kiểm tra giao diện khi nhập sai, khi đăng ký bị tắt và khi gặp quota.
- [x] 1.2 Dùng Playwright với Redis thật để kiểm tra email mới và email đã tồn tại nhận cùng phản hồi trên web. Đăng nhập và xác minh tài khoản mới thấy danh sách workspace trống (invariant 14, 16).

## 2. Workspace và project

- [x] 2.1 Thêm form tạo workspace và project vào các trang hiện hành. Kiểm tra gợi ý hợp lệ, giữ giá trị nhập tay, lỗi trùng tại trường, nút ở trạng thái danh sách trống hoặc có dữ liệu và quyền tạo project (invariant 1, 2, 16).
- [x] 2.2 Xử lý lỗi kết quả chưa rõ trên form. Chạy Playwright với Redis thật, kiểm tra điều hướng từ workspace mới đến board rỗng, lỗi trùng và việc chủ động gửi lại cùng payload và ID sau khi phản hồi bị mất, chỉ tạo một tài nguyên (invariant 1, 2, 16, 17).

## 3. Task đầu tiên trên Kanban

- [x] 3.1 Thêm form chỉ có tiêu đề và điều phối với thao tác ghi board hiện có. Kiểm tra việc đóng form, đưa tiêu điểm tới thẻ mới trong To do, và thử lại chỉ đọc nếu ghi đã thành công nhưng tải board lỗi (invariant 2, 4, 5, 8, 9, 17).
- [x] 3.2 Cập nhật hướng dẫn chạy local. Chạy build, typecheck và Playwright với Redis thật cho luồng từ đăng ký đến task đầu tiên, mở chi tiết và tải lại board để kiểm tra issue key và cột. Kiểm tra mất phản hồi khi tạo task và chạy lại kịch bản demo kéo thả và sửa task hiện có (invariant 2, 4, 5, 8, 9, 17).
