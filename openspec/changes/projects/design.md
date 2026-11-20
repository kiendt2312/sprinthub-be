## Context

Design v1.7, US-19 và spec workspace hiện hành xác định quyền từ membership thật. Dùng library v5 chung với `tasks-and-board`. Invariant 2 bảo đảm đúng workspace. Invariant 8, 9, 13 và 17 áp cho version, key, seq và replay.

## Goals / Non-Goals

Triển khai vòng đời project, unique key, giữ project archived đọc được và giữ chỉ mục permalink. Repair apply và quản lý sprint thuộc P1.

## Decisions

`workspace-projects:{wid}` là SET tất cả project. `workspace-projects-page:{wid}` là ZSET score 0 cùng ID để `ZRANGE BYLEX` theo batch hữu hạn. `project-key:{wid}:{key}` là STRING giữ chỗ cả khi project archived. Có thể đổi key trước khi cấp issue number đầu tiên. Counter vẫn giữ sau khi xóa task, nên một project từng có task giữ key vĩnh viễn. Listing xác thực membership trong batch đọc tài liệu, lọc theo workspace thật và trạng thái archive trước khi trả. Cursor gắn workspace, actor, chế độ archived và ID cuối. `archived=true` bao gồm cả archived, mặc định chỉ active.

| Function | KEYS theo thứ tự, sau prefix | ARGS theo thứ tự |
| --- | --- | --- |
| `sh_create_project` | workspace-members:wid, workspace:wid, project:pid, workspace-projects:wid, workspace-projects-page:wid, project-key:wid:newKey, outbox | wid, pid, actor, newKey, name, description, meta |
| `sh_update_project` | workspace-members:wid, workspace:wid, project:pid, project-key:wid:oldKey, project-key:wid:newKey, project-task-seq:pid, outbox | wid, pid, actor, oldKey, newKey, mode (update/archive/unarchive), expectedVersion, patchJson, meta |

`outbox` là `workspace-seq:wid`, `workspace-changes:wid`, `stream:domain-events`, `idempotency:actor:idem`. `meta` là idem, hash, nowMs, requestId, clientMutationId. Patch JSON có name/description tùy chọn, key đích lấy từ ARGS. Hash gồm thao tác, đích HTTP và payload chuẩn hóa kể cả mutation ID. ID dự sinh, key snapshot cũ, giờ server và request ID là dữ liệu caller.

1. Đối chiếu KEYS. Load workspace và project thật nếu sửa, đối chiếu tên ID và tenant. Key cũ lệch snapshot trả `KEYS_MISMATCH` nội bộ.
2. Kiểm membership, sau đó quyền OWNER/ADMIN. Actor ngoài tenant nhận 404, MEMBER nhận 403.
3. Tra idempotency. Kiểm suspend/archive cho lệnh mới, trừ unarchive đối với archive. Unarchive khi đang active trả trạng thái hiện tại, lưu replay và giữ version/seq. Archive một project đã archived với key mới trả `PROJECT_ARCHIVED`.
4. Kiểm expectedVersion, unique key, counter và kiểu của tất cả key sẽ ghi. Nguồn cũ phải trỏ về project khi đổi key. Cấp key và index cùng JSON, tăng seq/version, thêm `project:pid` vào workspace-changes, phát một event `PROJECT_CREATED`, `PROJECT_UPDATED`, `PROJECT_ARCHIVED` hoặc `PROJECT_UNARCHIVED`. Lưu replay cuối.
5. API chỉ đọc lại và thử tối đa hai lần sau reply `KEYS_MISMATCH` xác định chưa ghi. Timeout trả 503 cho client retry cùng key.

## Risks / Trade-offs

ZSET phân trang thêm một index có thể dựng lại từ JSON, giữ số ID mỗi truy vấn Redis có giới hạn. Bản ghi archived giữ key để không làm trùng permalink. Workspace suspend trả 423 cho mutation mới, quyền được kiểm trước replay như workspace.
