# HTTP contract workspace và membership

Prefix `/api/v1`. Mọi route yêu cầu cookie `__Host-sh_session`. Kế thừa
`X-Request-Id`, `Server-Timing`, `Cache-Control: no-store` và envelope lỗi
`{error:{code,params},requestId}`. Mutation yêu cầu `Origin` khớp cấu hình,
`X-CSRF-Protection: 1`, `Idempotency-Key` (1–128 ký tự `[A-Za-z0-9._-]`)
và `X-Client-Mutation-Id` (ULID). Quota ghi 120/phút/user, trả `Retry-After`
và `RateLimit` như contract auth. Body JSON từ chối field ngoài schema, sai
kiểu hoặc null. Route body rỗng nhận request không body hoặc JSON `{}`.
Chỉ hai route danh sách nhận query.

## Dữ liệu

- `Workspace` có `id`, `name`, `slug`, `ownerId`, `role` của actor,
  `version`, `createdAt` (ISO UTC), `createdAtMs` (epoch ms).
- `Member` có `userId` và `role`. Role là `OWNER | ADMIN | MEMBER`.
- `wid` là `ws_<ULID>`; `uid`/ `userId` là `usr_<ULID>`. `name` dài
  1–100 Unicode code point sau trim. `slug` dài 1–64 ASCII, mẫu
  `[a-z0-9]+(?:-[a-z0-9]+)*` (khớp toàn chuỗi). Email dùng cùng quy tắc
  validate và chuẩn hóa như auth.
- `expectedVersion` là số nguyên an toàn dương từ Workspace gần nhất
  hoặc `workspaceVersion` của trang thành viên. Các thay đổi membership
  tăng version workspace để cả hai PATCH cùng phát hiện xung đột.
- Danh sách dùng `limit` 1–100, mặc định 50, và `cursor` opaque tùy chọn.
  Thứ tự ID tăng dần; `nextCursor` null khi đã hết. Cursor ràng buộc
  với loại danh sách và actor (cùng workspace nếu có).

## Routes

| Method và path | Body | Thành công |
| --- | --- | --- |
| `POST /workspaces` | `{name,slug}` | `201 {data:Workspace,seq,requestId}` |
| `GET /workspaces` | — | `200 {data:Workspace[],nextCursor,requestId}` |
| `GET /workspaces/{wid}` | — | `200 {data:Workspace,seq,requestId}` |
| `PATCH /workspaces/{wid}` | `{expectedVersion,name?,slug?}`, ít nhất một field sửa | `200 {data:Workspace,seq,requestId}` |
| `GET /workspaces/{wid}/members` | — | `200 {data:Member[],workspaceVersion,nextCursor,seq,requestId}` |
| `POST /workspaces/{wid}/members` | Đúng một trong `{userId}`, `{email}` | `201 {data:Member,seq,requestId}`, role mới là `MEMBER` |
| `PATCH /workspaces/{wid}/members/{uid}` | `{expectedVersion,role:"ADMIN"\|"MEMBER"}` | `200 {data:Member,seq,requestId}` |
| `DELETE /workspaces/{wid}/members/{uid}` | Rỗng | `200 {data:{userId},seq,requestId}` |
| `POST /workspaces/{wid}/leave` | Rỗng | `200 {data:{userId},seq,requestId}` |
| `POST /workspaces/{wid}/transfer-ownership` | `{userId}`, thành viên khác actor | `200 {data:Workspace,seq,requestId}`, role của Owner cũ là `ADMIN` |

Member có quyền đọc, Admin có quyền sửa workspace và thêm/xóa MEMBER. Chỉ
Owner được xóa ADMIN, đổi role và chuyển Owner. Actor muốn tự gỡ dùng
`/leave`. Owner phải chuyển quyền trước. Response phép đọc kiểm quyền
mới tại Redis. Replay giữ `data` và `seq` cũ, còn `requestId` là của
request hiện tại. Sau transfer, Owner cũ vẫn còn là thành viên và có thể
replay đúng thao tác transfer đã thành công. Sau leave, request mới
nhận 404 theo quy tắc tenant. Retry 503 dùng lại cả hai header mutation.
Hash bao gồm thao tác, đích và payload chuẩn hóa, kể cả mutation ID.

| Status | Code | Điều kiện hoặc params |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | Body, path, cursor, query hoặc header sai |
| 401 | `SESSION_INVALID` | Cookie không hợp lệ |
| 403 | `CSRF_INVALID`, `FORBIDDEN` | CSRF lỗi hoặc member thiếu quyền |
| 404 | `NOT_FOUND` | Workspace không có/actor ngoài tenant hoặc user đích không tìm thấy |
| 409 | `WORKSPACE_SLUG_TAKEN`, `MEMBER_ALREADY_EXISTS` | Slug tồn tại hoặc user đã là member |
| 409 | `WORKSPACE_VERSION_CONFLICT` | `{currentVersion:integer}` |
| 409 | `WORKSPACE_OWNER_REQUIRED` | Cố rời, gỡ hoặc đổi role Owner |
| 422 | `IDEMPOTENCY_KEY_REUSED`, `INVALID_MEMBER_TARGET` | Key đã dùng cho nội dung khác, hoặc transfer/gỡ bằng route đích trỏ chính actor |
| 423 | `WORKSPACE_SUSPENDED` | Workspace bị suspend và request mutation mới |
| 429 | `RATE_LIMITED` | Quota ghi |
| 500 | `INTERNAL_ERROR` | Lỗi nội bộ |
| 503 | `REDIS_UNAVAILABLE`, `MUTATION_OUTCOME_UNKNOWN` | Redis lỗi hoặc kết quả ghi chưa rõ |

Mã lỗi có `params: {}` trừ trường hợp ghi rõ.
