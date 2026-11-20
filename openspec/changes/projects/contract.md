# HTTP contract project

Prefix `/api/v1`. Session cookie, CSRF, header/request envelope, quota ghi 120/phút/user và replay giống [contract workspace](../archive/2026-11-20-workspaces-and-membership/contract.md). Mọi route chỉ trả dữ liệu của workspace thật mà actor còn membership. Mutation yêu cầu OWNER/ADMIN. Body chỉ chấp nhận field khai báo. Route ngoài danh sách từ chối query.

`Project` gồm `id` (`prj_<ULID>`), `workspaceId`, `name` (trim, 1–100 ký tự), `key` (`[A-Z0-9]{2,10}`), `description` (0–20.000 ký tự, mặc định chuỗi rỗng), `createdBy`, `createdAt` (ISO UTC), `createdAtMs`, `archivedAt` (ISO UTC hoặc null), `version`. Độ dài tính theo Unicode code point.

| Method và path | Input | Thành công |
| --- | --- | --- |
| `POST /workspaces/{wid}/projects` | `{name,key,description?}` | `201 {data:Project,seq,requestId}` |
| `GET /workspaces/{wid}/projects` | `archived=true\|false`, `limit` 1–100 (50), `cursor` opaque | `200 {data:Project[],nextCursor,requestId}` |
| `GET /projects/{pid}` | — | `200 {data:Project,seq,requestId}` |
| `PATCH /projects/{pid}` | `{expectedVersion,name?,key?,description?}`, ít nhất một field sửa | `200 {data:Project,seq,requestId}` |
| `POST /projects/{pid}/archive` | `{expectedVersion}` | `200 {data:Project,seq,requestId}` |
| `POST /projects/{pid}/unarchive` | `{expectedVersion}` | `200 {data:Project,seq,requestId}` |

Pagination tăng theo ID. `nextCursor=null` khi đã hết. `archived=true` bao gồm project active và archived. Mặc định và `archived=false` chỉ active. Key giữ chỗ trong workspace cả khi archive. Archive giữ quyền đọc. Unarchive khi project đã active chỉ thành công nếu expectedVersion vẫn khớp, trừ khi trả replay đã lưu.

| Status | Code | Params |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | {} |
| 401 | `SESSION_INVALID` | {} |
| 403 | `FORBIDDEN`, `CSRF_INVALID` | {} |
| 404 | `NOT_FOUND` | {} |
| 409 | `PROJECT_KEY_TAKEN`, `PROJECT_KEY_IMMUTABLE` | {} |
| 409 | `PROJECT_VERSION_CONFLICT` | `{currentVersion}` |
| 422 | `PROJECT_ARCHIVED`, `IDEMPOTENCY_KEY_REUSED` | {} |
| 423 | `WORKSPACE_SUSPENDED` | {} |
| 429 | `RATE_LIMITED` | Theo contract auth |
| 500 | `INTERNAL_ERROR` | {} |
| 503 | `REDIS_UNAVAILABLE`, `MUTATION_OUTCOME_UNKNOWN` | {} |
