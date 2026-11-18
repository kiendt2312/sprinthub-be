## Purpose

Lưu task của SprintHub trong Redis với issue key duy nhất, thứ tự cột ổn định và mọi
thay đổi nhiều key đi qua Redis Function kiểm tra điều kiện trước khi ghi.

## ADDED Requirements

### Requirement: Issue key duy nhất theo project
Hệ thống SHALL cấp cho mỗi task mới một số thứ tự tăng dần theo project và key dạng
`{PROJECT_KEY}-{n}`; không hai task nào có cùng key, số không được tái sử dụng.

#### Scenario: Tạo task song song
- **WHEN** 50 yêu cầu tạo task cho cùng một project chạy đồng thời
- **THEN** 50 task được tạo với 50 số thứ tự khác nhau và mỗi `task-key` trỏ đúng task của nó

### Requirement: Thay đổi task đi qua Function có kiểm tra trước khi ghi
Mọi thao tác tạo, di chuyển, gán task SHALL chạy trong một Redis Function; Function
SHALL kiểm tra membership của actor, assignee còn là member, `expectedVersion` và
idempotency key trước lệnh ghi đầu tiên.

#### Scenario: Assignee vừa bị xóa khỏi workspace
- **WHEN** yêu cầu tạo task gán cho user X chạy cùng lúc với thao tác xóa X khỏi workspace
- **THEN** không task nào được lưu với `assigneeId` = X sau khi X đã không còn là member

#### Scenario: Retry cùng Idempotency-Key
- **WHEN** client gửi lại yêu cầu tạo task với cùng `Idempotency-Key` và cùng payload
- **THEN** hệ thống trả lại kết quả lần đầu và không tạo task thứ hai

#### Scenario: Cùng Idempotency-Key khác payload
- **WHEN** client dùng lại một `Idempotency-Key` với payload khác
- **THEN** hệ thống từ chối với mã `IDEMPOTENCY_KEY_REUSED` và không ghi gì

### Requirement: Di chuyển task có kiểm soát version
Hệ thống SHALL chỉ chấp nhận chuyển trạng thái theo bảng cho phép, SHALL tăng
`version` đúng 1 cho mỗi lần di chuyển thành công, và SHALL đảm bảo task active nằm
trong đúng một ZSET board khớp `status` với score bằng `position`.

#### Scenario: Hai client di chuyển cùng version
- **WHEN** hai yêu cầu di chuyển cùng một task mang cùng `expectedVersion` chạy đồng thời
- **THEN** đúng một yêu cầu thành công, yêu cầu còn lại nhận `VERSION_CONFLICT`, và task nằm trong đúng một cột

#### Scenario: Chuyển trạng thái không hợp lệ
- **WHEN** yêu cầu chuyển task từ TODO sang DONE
- **THEN** hệ thống từ chối với `INVALID_STATUS_TRANSITION` và không thay đổi dữ liệu

#### Scenario: Retry mutation của chính mình
- **WHEN** client gửi lại một lần di chuyển có `clientMutationId` trùng với mutation cuối của task
- **THEN** hệ thống trả trạng thái hiện tại với kết quả thành công thay vì `VERSION_CONFLICT`

### Requirement: Thứ tự cột bằng sparse integer có rebalance
Vị trí trong cột SHALL là số nguyên cách quãng 1024; khi không còn khoảng trống giữa
hai vị trí, hệ thống SHALL đánh số lại cả cột giữ nguyên thứ tự mà không tăng
`version` của các task bị đánh số lại.

#### Scenario: Hết khoảng trống
- **WHEN** liên tục chèn task vào giữa cùng hai task cho tới khi khoảng cách nhỏ hơn 2
- **THEN** cột được đánh số lại, thứ tự hiển thị không đổi và `version` của các task bị đánh số lại giữ nguyên

### Requirement: Kiểm tra index dựng lại được từ dữ liệu gốc
Hệ thống SHALL cung cấp thao tác so sánh JSON gốc với các index (`project-tasks`,
board ZSET, `task-key`) và báo cáo các mục thiếu, thừa hoặc sai score.

#### Scenario: Index bị làm hỏng có chủ đích
- **WHEN** một task bị xóa khỏi ZSET board trong khi JSON gốc vẫn còn
- **THEN** báo cáo kiểm tra liệt kê task đó ở mục missing
