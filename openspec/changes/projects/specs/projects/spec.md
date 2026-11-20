## ADDED Requirements

### Requirement: Vòng đời project theo tenant

Hệ thống SHALL cho OWNER/ADMIN tạo, sửa, archive và unarchive project. Thành viên SHALL đọc được project của workspace. Quyền SHALL được kiểm trong Function trước replay và trước mọi ghi.

#### Scenario: Quyền đọc và ghi
- **WHEN** OWNER hoặc ADMIN tạo project rồi MEMBER trong workspace xem, sửa hoặc archive project
- **THEN** xem thành công, sửa và archive trả `403 FORBIDDEN`. MEMBER tạo project cũng nhận 403. Actor ngoài workspace nhận `404 NOT_FOUND` cho đọc và ghi.

### Requirement: Unique project key và version

Project key SHALL khớp `[A-Z0-9]{2,10}`, unique trong workspace và giữ chỗ khi archived. Sau số issue đầu tiên, key SHALL bất biến. Ghi project SHALL kiểm version, ghi JSON, index, seq và một event trong một Function.

#### Scenario: Hai lệnh tạo tranh key
- **WHEN** hai admin cùng workspace đồng thời tạo hai project có cùng key
- **THEN** đúng một thành công và một nhận `409 PROJECT_KEY_TAKEN`. Workspace khác có thể dùng cùng key.

#### Scenario: Đổi key và sửa cạnh tranh
- **WHEN** project chưa từng cấp số task và hai lệnh sửa dùng cùng version
- **THEN** chỉ một thành công, lệnh còn lại nhận `409 PROJECT_VERSION_CONFLICT` với `currentVersion`. Khi đổi key thành công, key cũ được trả lại. Đổi sau khi từng cấp số issue nhận `409 PROJECT_KEY_IMMUTABLE`.

### Requirement: Chỉ chặn ghi mới sau archive

Archive SHALL ẩn project khỏi list mặc định, giữ list có `archived=true` và giữ quyền đọc/permalink. Mutation nghiệp vụ mới vào project/task archived SHALL trả `422 PROJECT_ARCHIVED`, ngoại trừ unarchive, worker unassign và admin repair. Replay hợp lệ SHALL đứng trước kiểm tra archive.

#### Scenario: Archive qua vòng đời task
- **WHEN** admin archive project có task đã gán, member đọc task qua key và admin gỡ assignee khỏi workspace
- **THEN** project ẩn mặc định, hiện với `archived=true`, đọc chi tiết và qua key còn hoạt động, worker dọn assignee, ghi mới nhận 422 và ghi lại được sau unarchive.

#### Scenario: Replay qua archive và mất quyền
- **WHEN** mutation thành công được gửi lại cùng key/payload sau archive
- **THEN** actor còn quyền nhận data và seq cũ, không phát sinh ghi. Actor đã mất membership nhận 404. Cùng key khác payload nhận 422.

### Requirement: Trang danh sách project

Danh sách SHALL dùng cursor gắn actor, workspace và bộ lọc archived. Thứ tự tăng theo ID, page limit không quá 100 và không dùng offset, KEYS hay SCAN trong request.

#### Scenario: Duyệt nhiều trang project
- **WHEN** member đọc hết danh sách qua cursor của chính bộ lọc, với project active và archived
- **THEN** mỗi project hợp lệ xuất hiện một lần theo ID. Dùng cursor cho bộ lọc, workspace hoặc actor khác nhận 400.

### Requirement: Verifier vòng đời project

Verifier offline SHALL so project JSON, workspace, SET, ZSET phân trang và unique key theo hai chiều. Project archived SHALL giữ các index và unique key.

#### Scenario: Phát hiện index project lệch
- **WHEN** verifier đọc fixture project hợp lệ và fixture có index thiếu, sai owner key hoặc index trỏ project không có JSON
- **THEN** fixture lành sạch và fixture hỏng báo đúng mục lệch.
