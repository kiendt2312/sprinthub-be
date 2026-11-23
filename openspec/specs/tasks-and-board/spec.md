# tasks-and-board Specification

## Purpose

Quản lý task và thứ tự Kanban theo project, gồm issue key, phân quyền theo workspace, bộ lọc, phân trang và kiểm tra index.

## Requirements

### Requirement: Cấp issue key và index active atomically

Đường tạo task HTTP SHALL lưu JSON, issue key, project-tasks, board TODO, backlog và reverse assignee trong Function. Cấp số, kiểm tenant, quyền, assignee và replay SHALL tuân theo redis-task-core.

#### Scenario: T-004 và T-009
- **WHEN** 50 thao tác tạo chạy trên 50 kết nối Redis riêng rồi caller dùng lại một key với payload khác
- **THEN** có 50 số khác nhau với index hai chiều sạch và lệnh sau nhận `422 IDEMPOTENCY_KEY_REUSED`.

#### Scenario: T-008
- **WHEN** Redis đã ghi create nhưng caller mất reply và client gửi lại cùng header và payload
- **THEN** HTTP trả 503 cho lần mất reply. Lần retry nhận cùng task và seq, chỉ một task và event được ghi.

### Requirement: Đọc và ghi kiểm tenant thật

Mọi đường task, list và board SHALL xác minh project/workspace thật và membership trước khi trả dữ liệu hoặc ghi. Permalink SHALL đối chiếu field trong HASH với task thật và giữ đọc khi project archived.

#### Scenario: T-003
- **WHEN** actor ngoài workspace biết task ID hoặc key và project ID
- **THEN** mọi đường đọc/ghi đều trả `404 NOT_FOUND`, kể cả tra ID/key, board, list và thử replay.

### Requirement: Update, assign và xóa mềm

Update, assign và delete SHALL kiểm expectedVersion trong Function và ghi version, seq, event một lần. Delete SHALL cho MEMBER xóa task do mình tạo, gỡ mọi index active và giữ issue key. Ghi mới SHALL bị chặn khi project archived, sau khi kiểm quyền/replay.

#### Scenario: Update và tranh version
- **WHEN** hai actor dùng cùng version sửa title, hoặc gửi assignee ngoài workspace
- **THEN** duy nhất một sửa thành công, lệnh còn lại nhận 409 có `currentVersion`, assignee không hợp lệ nhận 422. Markdown, due và reverse index của sửa hợp lệ round-trip đúng.

#### Scenario: Xóa, retry và create kế tiếp
- **WHEN** member xóa task người khác rồi xóa task mình tạo và retry delete với cùng key
- **THEN** lệnh đầu 403, lệnh sau trả tombstone và replay cùng seq. Đọc ID/key đã xóa nhận 404, mọi index active sạch, số task mới cao hơn.

### Requirement: Thứ tự board tương thích redis-task-core

Move SHALL dùng sơ đồ transition, version, neo, cap 500 và rebalance của redis-task-core. Cập nhật bản thân task và event một lần, giữ version những task khác. Reorder trong cột đầy SHALL tiếp tục hoạt động.

#### Scenario: T-005, T-006 và T-012
- **WHEN** hai caller move cùng version, một tab nối tiếp move bằng version mới, rồi reorder ép rebalance
- **THEN** tranh chấp trả một thành công và một 409, hai bước nối tiếp đều thành công, và rebalance ghi một event với `rebalancedColumn`, đúng thứ tự, version task khác giữ nguyên.

#### Scenario: Neo sai, transition sai và cột đầy
- **WHEN** caller gửi neo không hợp lệ, transition bị cấm hoặc tạo/thêm vào cột 500 task
- **THEN** nhận mã lỗi tương ứng, dữ liệu không đổi. Hai caller tranh slot 500 chỉ một thành công.

### Requirement: Board ba batch

Board 200 task SHALL dùng tối đa ba batch Redis với pipeline JSON.GET nhiều path. Board SHALL kiểm membership, trạng thái, tenant, project và xóa mềm trong batch cuối. Mỗi cột giữ thứ tự ZSET.

#### Scenario: T-021
- **WHEN** gọi board chứa 200 task và fixture đổi hoặc làm lệch một số task sau lúc lấy ZSET
- **THEN** ba batch phục vụ request, dữ liệu lệch bị bỏ qua, payload chỉ gồm card hợp lệ, không có description.

### Requirement: Trang lọc đầy đủ

Task list SHALL lọc đúng status, assignee, priority, trả tối đa 100 item, dùng cursor (score, ID) opaque, và cho fixture ổn định trả mỗi task phù hợp đúng một lần. Cursor SHALL gắn bộ lọc, actor, project.

#### Scenario: Cursor với score trùng
- **WHEN** duyệt fixture 250 task qua limit 100 và bộ lọc có score trùng ở ranh giới trang
- **THEN** mỗi task phù hợp xuất hiện đúng một lần theo thứ tự. Thay bộ lọc/project/actor với cursor cũ nhận 400.

### Requirement: Bền và kiểm tra index

Task và thứ tự SHALL còn qua restart. Verifier offline SHALL nhận biết lỗi trên index active, backlog và permalink, và hỗ trợ kiểm theo fixture.

#### Scenario: Restart và verifier T-020
- **WHEN** đã tạo, move, xóa task rồi restart Redis, chạy verifier trên fixture cô lập và sửa hỏng index trong fixture riêng
- **THEN** task và thứ tự phục hồi, verifier báo sạch cho fixture lành và chỉ đúng lỗi trong fixture hỏng.
