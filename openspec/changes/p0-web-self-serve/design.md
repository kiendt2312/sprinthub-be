# Design

## Context

`sprinthub-ui` đã có màn đăng nhập, danh sách workspace, trang workspace và board. Dùng lại các màn này, lớp gọi API cùng origin, kiểu sinh từ [OpenAPI](../../../openapi.json) và trạng thái phiên của demo hiện hành.

## Goals / Non-Goals

**Goals**

- Giữ một đường dẫn trực tiếp tới từng tài nguyên sau khi tạo và dùng contract hiện hành cho mọi thao tác.
- Phân biệt thao tác ghi chưa rõ kết quả với lỗi đọc xảy ra sau khi backend đã xác nhận ghi thành công.

**Non-Goals**

- Wizard riêng, bản nháp lưu trên thiết bị và thay đổi API hoặc dữ liệu Redis.

## Decisions

### Đăng ký và đăng nhập là hai bước

`POST /api/v1/auth/register` nhận email, mật khẩu và tên hiển thị, trả `202` với cùng nội dung cho email mới và email đã tồn tại. Giữ email trong bộ nhớ qua điều hướng nội bộ đến form đăng nhập để email không xuất hiện trong URL. Form đăng nhập gọi `POST /api/v1/auth/login` như hiện tại. Thông báo chấp nhận dùng cùng nội dung và form tải lại không giữ mật khẩu đăng ký.

### Form trên trang chứa tài nguyên

| Thao tác | API hiện hành | Điều hướng sau thành công |
| --- | --- | --- |
| Tạo workspace từ `/workspaces` | `POST /api/v1/workspaces`, gửi `name` và `slug` | Trang workspace mới |
| Tạo project từ trang workspace | `POST /api/v1/workspaces/{workspaceId}/projects`, gửi `name` và `key` | Board của project mới |
| Tạo task từ board | `POST /api/v1/projects/{projectId}/tasks`, gửi `title` | Giữ URL hiện tại và đọc lại board |

Gợi ý slug chữ thường với các phần cách nhau bằng dấu gạch nối. Gợi ý mã project từ chữ và số ASCII trong tên, viết hoa và giới hạn theo contract. Giữ giá trị đã được người dùng sửa trong suốt vòng đời form. Khi không thể sinh gợi ý hợp lệ, để trống và yêu cầu người dùng điền. Hiển thị lỗi trùng tại trường liên quan. Dùng catalog cho thông báo EN/VI mới và locale của người dùng khi có phiên.

Server quyết định quyền tạo. Web dùng role từ dữ liệu phiên để hiển thị thao tác tạo project và xử lý trường hợp quyền đã thay đổi. Tạo task điều phối với các lần ghi và đọc board đang chạy để tránh ghi đè dữ liệu trên giao diện. Dùng ID trả về từ API để đưa tiêu điểm đến thẻ sau khi lần đọc board thành công.

### Phục hồi sau lỗi

Dùng JSON cùng origin và header CSRF hiện hành. Mỗi lần tạo workspace, project hoặc task mang một cặp `Idempotency-Key` và `X-Client-Mutation-Id`. Giữ một thao tác đang gửi trên mỗi form. Nếu mất phản hồi hoặc API báo kết quả chưa rõ, lần thử lại chủ động dùng đúng cặp ID và payload đã gửi. Khi API xác nhận đã tạo task, bỏ trạng thái thử lại ghi và chỉ cho thử lại đọc board nếu cần.

## Risks / Trade-offs

- Tải lại hoặc rời trang làm mất ngữ cảnh thử lại. Danh sách và board lấy dữ liệu hiện hành từ API khi người dùng quay lại.
- Bài kiểm tra đăng ký tiêu tốn quota theo IP. Chạy kịch bản tài khoản mới trên stack Redis test cô lập và chạy lại suite demo với fixture phù hợp.
