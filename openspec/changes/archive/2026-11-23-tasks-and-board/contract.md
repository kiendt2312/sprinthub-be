# HTTP contract task và board

Prefix `/api/v1`. Giống [contract project](../2026-11-23-projects/contract.md) về session, CSRF, header, quota ghi và envelope. Chỉ list nhận query. ID task là `tsk_<ULID>`. Issue key là `[A-Z0-9]{2,10}-[1-9][0-9]*`. Các số dùng số nguyên an toàn JavaScript.

- `Task` gồm `id, workspaceId, projectId, number, key, title, description, descriptionFormat, status, priority, assigneeId, reporterId, sprintId, labelIds, dueAtMs, createdAt, createdAtMs, deletedAt, lastSeq, lastClientMutationId, version`. P0 `sprintId` là null, `labelIds` là mảng rỗng. `descriptionFormat` là markdown. `deletedAt` chỉ khác null trong phản hồi delete/replay tương ứng.
- `title` trim, 1–200 code point. Markdown nguyên văn tối đa 20.000 code point, mặc định rỗng. `priority`: `LOW|MEDIUM|HIGH|URGENT`, mặc định MEDIUM. `assigneeId` và `dueAtMs` nhận null, mặc định null. `dueAtMs` là epoch ms không âm.
- `BoardCard` gồm `id,key,title,priority,assigneeId,dueAtMs,labelIds,version`. `Board` có `projectId` và `columns` là object bốn mảng card theo thứ tự, key `TODO`, `IN_PROGRESS`, `IN_REVIEW`, `DONE`. Quota board 120/phút theo digest session, gồm một batch với session guard.
- `expectedVersion` là số nguyên an toàn dương. Mutation trả `{data:Task,seq,requestId}`, với `rebalancedColumn` tùy chọn ở cấp envelope khi create/move rebalance. Retry giữ data, seq và rebalancedColumn đã lưu. RequestId ở HTTP là request hiện tại.

| Method và path | Body hoặc query | Thành công |
| --- | --- | --- |
| `POST /projects/{pid}/tasks` | `{title,description?,priority?,dueAtMs?,assigneeId?}` | 201, status ban đầu TODO |
| `GET /projects/{pid}/tasks` | `status?,assigneeId?,priority?,limit?,cursor?` | `200 {data:Task[],nextCursor,requestId}` |
| `GET /projects/{pid}/board` | — | `200 {data:Board,requestId}` |
| `GET /tasks/{tid}` | — | `200 {data:Task,requestId}` |
| `GET /workspaces/{wid}/tasks/by-key/{key}` | — | `200 {data:Task,requestId}` |
| `PATCH /tasks/{tid}` | `{expectedVersion,title?,description?,priority?,dueAtMs?,assigneeId?}`, ít nhất một field sửa | 200 |
| `PATCH /tasks/{tid}/assignee` | `{expectedVersion,assigneeId}`, null để bỏ gán | 200 |
| `PATCH /tasks/{tid}/move` | `{expectedVersion,to,afterTaskId?,beforeTaskId?}` | 200 |
| `DELETE /tasks/{tid}` | `{expectedVersion}` | 200, tombstone |

List dùng AND các bộ lọc, `assigneeId=UNASSIGNED` lọc task chưa gán. Limit 1–100, mặc định 50. Cursor opaque gắn bộ lọc và tenant. `nextCursor` null khi hết. Actor ngoài tenant luôn nhận 404 sau khi qua xác thực/cấu trúc. Member chỉ được xóa task mình tạo.

| Status | Code | Params |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | {} |
| 401 | `SESSION_INVALID` | {} |
| 403 | `FORBIDDEN`, `CSRF_INVALID` | {} |
| 404 | `NOT_FOUND` | {} |
| 409 | `TASK_VERSION_CONFLICT`, `COLUMN_FULL` | `{currentVersion}` hoặc `{limit:500}` |
| 422 | `PROJECT_ARCHIVED`, `ASSIGNEE_NOT_MEMBER`, `INVALID_STATUS_TRANSITION`, `INVALID_POSITION_ANCHOR`, `IDEMPOTENCY_KEY_REUSED` | {} |
| 423 | `WORKSPACE_SUSPENDED` | {} |
| 429 | `RATE_LIMITED` | Theo contract auth |
| 500 | `INTERNAL_ERROR` | {} |
| 503 | `REDIS_UNAVAILABLE`, `MUTATION_OUTCOME_UNKNOWN` | {} |
