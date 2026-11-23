# web-task-board Specification

## Purpose

Cho phép thành viên mở bảng Kanban của project trên web, chỉnh sửa nội dung task và tổ chức thứ tự công việc trên bảng.

## Requirements

### Requirement: Mở Kanban từ phiên đăng nhập
Web SHALL cho người dùng đăng nhập và chọn workspace, project từ dữ liệu phiên hiện hành. Bảng SHALL hiển thị bốn cột theo thứ tự backend trả về cho các thẻ trong từng cột.

#### Scenario: Mở board từ dữ liệu demo
- **GIVEN** tài khoản có quyền truy cập workspace và project đã chuẩn bị
- **WHEN** người dùng đăng nhập, chọn workspace và mở project
- **THEN** web hiển thị các cột To do, In progress, In review và Done với task thật của project theo đúng thứ tự

#### Scenario: Phiên hết hiệu lực
- **WHEN** API trả `SESSION_INVALID` khi mở hoặc tải lại board
- **THEN** web yêu cầu đăng nhập và ngừng hiển thị dữ liệu riêng của phiên cũ

### Requirement: Xem và sửa nội dung task
Web SHALL cho phép mở chi tiết từ thẻ và lưu tiêu đề, mô tả Markdown. Web SHALL hiển thị trạng thái, độ ưu tiên, người phụ trách và hạn chót từ API. Markdown hiển thị SHALL được sanitize.

#### Scenario: Lưu và tải lại
- **WHEN** người dùng đổi tiêu đề và mô tả rồi lưu thành công
- **THEN** tiêu đề trên thẻ cập nhật và khi tải lại trang chi tiết, cả hai trường khớp dữ liệu đã lưu

#### Scenario: Lưu gặp xung đột
- **WHEN** API trả `TASK_VERSION_CONFLICT` khi lưu nội dung
- **THEN** web báo xung đột, giữ bản nháp và cho tải phiên bản mới nhất để đối chiếu
- **AND** một lần áp dụng lại cần thao tác chủ động của người dùng

### Requirement: Di chuyển và sắp xếp task bằng chuột
Web SHALL hỗ trợ kéo thả trên desktop để chuyển sang cột hợp lệ hoặc sắp xếp trong cùng cột. Web SHALL phản ánh vị trí vừa thả ngay và đồng bộ với kết quả backend.

#### Scenario: Chuyển cột vào một vị trí cụ thể
- **WHEN** người dùng thả task giữa hai thẻ của cột đích hợp lệ và backend chấp nhận
- **THEN** thẻ xuất hiện đúng vị trí thả và giữ vị trí đó sau khi tải lại

#### Scenario: Sắp xếp trong cùng cột
- **WHEN** người dùng đổi vị trí thẻ trong cột hiện tại và backend chấp nhận
- **THEN** thứ tự mới xuất hiện ngay và được giữ sau khi tải lại

### Requirement: Đồng bộ board sau lỗi di chuyển
Web SHALL đối chiếu lại board từ backend khi một lần kéo thả bị từ chối hoặc khi kết quả lưu chưa rõ. Web SHALL báo trạng thái cho người dùng.

#### Scenario: Backend từ chối di chuyển
- **WHEN** API trả xung đột, cột đầy, neo vị trí không còn hợp lệ hoặc chuyển trạng thái bị từ chối
- **THEN** web báo lý do và tải lại board để hiển thị thứ tự từ backend

#### Scenario: Mất phản hồi khi đang lưu
- **WHEN** kết nối bị gián đoạn hoặc backend báo kết quả mutation chưa rõ
- **THEN** web đối chiếu qua một lần đọc board thành công trước khi cho người dùng kéo lại task đó
- **AND** web không tự gửi lại request ghi

### Requirement: Đổi trạng thái trong Chi tiết task
Chi tiết task SHALL liệt kê các đích hợp lệ theo quy trình Kanban và lưu ngay khi người dùng chọn một trạng thái mới. Thẻ SHALL được thêm vào cuối cột đích. Bản nháp nội dung SHALL được giữ riêng khỏi thay đổi trạng thái.

#### Scenario: Đổi trạng thái và mở lại board
- **WHEN** người dùng chọn trạng thái hợp lệ và backend chấp nhận
- **THEN** chi tiết hiển thị trạng thái mới và Kanban hiển thị thẻ ở cuối cột đích, kể cả sau khi tải lại

#### Scenario: Thay đổi dựa trên phiên bản cũ
- **WHEN** backend từ chối chọn trạng thái do version cũ
- **THEN** chi tiết tải trạng thái đã lưu, báo lỗi và giữ bản nháp nội dung để đối chiếu khi cần
