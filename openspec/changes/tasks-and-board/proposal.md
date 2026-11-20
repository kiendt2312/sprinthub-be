## Why

US-05/06/07/08/09/20 cần đường ghi và đọc task đủ để team dùng Kanban P0 và giữ thứ tự qua reload, restart.

## What Changes

- Tạo task có issue key bền, đọc bằng ID hoặc key, sửa/gán, xóa mềm và di chuyển hoặc reorder có kiểm version.
- Thêm list/filter phân trang và board bốn cột với ba batch Redis.
- Nối lại đường create/move đã kiểm chứng trong spike và thêm backlog index. Kiểm bằng Redis thật, gồm fixture cô lập, concurrency và verifier offline.

## Capabilities

### New Capabilities

- `tasks-and-board`: API task, phân trang/filter, board và đường mutation v5.

### Modified Capabilities

## Impact

Phụ thuộc change `projects`. Bổ sung OpenAPI v1, module HTTP và Redis Functions. Scope P0 gồm backlog index. API sprint, label, comment, search và SSE thuộc P1.
