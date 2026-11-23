# Design

## Context

`sprinthub-ui` chưa có mã ứng dụng. API đã có auth, workspace, project, board và task. Change này tiêu thụ các contract [auth](../2026-11-20-auth-session-and-cli-admin/contract.md), [workspace](../2026-11-20-workspaces-and-membership/contract.md), [project](../2026-11-23-projects/contract.md) và [task/board](../2026-11-23-tasks-and-board/contract.md). `openapi.json` là nguồn sinh kiểu API.

## Goals / Non-Goals

- Dùng session, quyền, dữ liệu và thứ tự board từ backend để demo chạy được trên máy local.
- Giữ việc kiểm tra phiên, quyền, version và vị trí hợp lệ ở backend. Change này giữ nguyên chữ ký API và schema dữ liệu, nên không cần contract mới hoặc migration.

## Decisions

1. **Luồng và giao diện.** Dựng Next.js trong `sprinthub-ui` với các màn đăng nhập, chọn workspace/project, Kanban và chi tiết task có URL để tải lại trực tiếp. Dùng file Figma **User Sprinthub**, page **SprintHub · P0 Wireframes**, frame **07 Board / Kanban · UI Study** (`5:316`) và **09 Task / Detail & Edit · UI Study** (`5:539`). Dùng chung kiểu chữ, màu và điều hướng cho các màn dẫn vào demo. Chỉ hiện điều khiển có hành vi trong lát cắt. Các thuộc tính ngoài phạm vi sửa hiển thị ở chế độ đọc. Giá trị tùy chọn rỗng có trạng thái hiển thị riêng.
2. **Kết nối API.** Gọi cùng origin qua Next.js rewrite cho `/api/*`; cấu hình origin local theo contract auth và giữ cookie phiên do BE cấp. Sinh kiểu bằng `openapi-typescript`. Tập trung xử lý lỗi dựa vào `code` và `params` trong catalog EN để có thể thêm VI. Hợp đồng task và membership chỉ có ID người dùng. Dùng tên từ hồ sơ phiên nếu ID khớp người dùng hiện tại, hiển thị ID dưới dạng văn bản khi không có tên và hiển thị Unassigned khi ID là null. Fixture gán task cho tài khoản demo để xem tên thật mà không mở rộng API. Render preview Markdown có sanitize.
3. **Di chuyển.** Dùng thao tác thả để tính cột và vị trí đích từ thứ tự đang hiển thị. Bỏ thẻ đang kéo khỏi danh sách đích trước khi tính `afterTaskId` và `beforeTaskId`. Vị trí giữa hai thẻ gửi hai neo, đầu và cuối gửi neo tương ứng, cột rỗng bỏ cả hai. Bỏ qua thao tác thả giữ nguyên vị trí. Dùng đúng sơ đồ chuyển trạng thái của BE. Mỗi task tối đa một request ghi đang bay. Tạo một cặp `Idempotency-Key` và `X-Client-Mutation-Id` cho mỗi mutation và gửi version đang hiển thị.
4. **Đối chiếu và xung đột.** Board áp dụng vị trí dự kiến ngay khi thả. Khi thành công, dùng phản hồi để cập nhật trường và version của thẻ. Khi bị từ chối hoặc phản hồi không rõ, tải lại dữ liệu chuẩn và báo trạng thái. Nếu đọc lại thất bại, giữ trạng thái cần đồng bộ và cho thử lại thao tác đọc. Chỉ mở lại thao tác trên thẻ sau khi có dữ liệu chuẩn. Nếu người dùng thử lại đúng mutation có kết quả chưa rõ, giữ nguyên payload và cặp ID. Một ý định mới dùng version từ dữ liệu đã đồng bộ và một cặp ID mới. Với lỗi lưu nội dung, giữ bản nháp riêng khỏi bản mới tải. Khi người dùng chủ động áp dụng lại, dùng version mới.
5. **Dữ liệu demo.** Chuẩn bị fixture local qua các API sẵn có. Có tài khoản được cấp quyền, project và đủ task để thử thả vào giữa hai thẻ, sắp xếp trong một cột và tạo xung đột từ phiên thứ hai. Giữ thông tin xác thực trong cấu hình local. Hướng dẫn khởi chạy và chuẩn bị dữ liệu nằm trong repo frontend.

6. **Chọn trạng thái trong Chi tiết task.** Dùng cùng danh sách chuyển trạng thái với Kanban. Khi chọn, gọi API move với version hiện tại và bỏ neo để thêm vào cuối cột đích. Chia sẻ khóa ghi với form nội dung. Khi version cũ hoặc kết quả không rõ, đọc lại task trước khi mở khóa. Giữ bản nháp và dùng giao diện đối chiếu nếu nội dung mới trên server khác bản gốc khi người dùng còn bản nháp.

## Risks / Trade-offs

- Hai phiên có thể làm cũ version hoặc neo vị trí. Dùng API làm nguồn xác nhận và kiểm thử lỗi với dữ liệu đổi từ phiên thứ hai.
- Replay mutation có thể trả một snapshot đã cũ. Đọc lại board khi cần đối chiếu kết quả và tránh thay một snapshot mới hơn bằng phản hồi cũ.
- Frame Figma đang ở file mở trong editor. Khi bắt đầu apply, kiểm tra quyền truy cập hai frame hoặc lấy bản export trước khi triển khai giao diện.

## Migration Plan

Chạy frontend cùng môi trường BE local. Việc dừng frontend hoặc quay lại bản frontend trước đó độc lập với dữ liệu Redis.
