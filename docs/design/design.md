# SprintHub — Thiết kế chi tiết & Nghiên cứu thiết kế

Nov 18, 2026 · @Hieu Anh

Bản thiết kế v1.4: Platform Admin tách thành 2 repo riêng (`sprinthub-admin-ui`, `sprinthub-admin-service`). v1.3 giữ 6 lỗi P0 đã sửa ở v1.2, cập nhật theo buổi grilling 18/11/2026 (3 repo, SSE, song ngữ EN/VI, luồng local → prod trên Oracle Free, chi phí $0). Phần nghiên cứu và lý do nằm ở tab bên cạnh.

## Kiến trúc và phân lớp

Một monolith NestJS chia module theo nghiệp vụ, một worker cùng codebase, một Redis node. Chỉ API và worker kết nối Redis. Trình duyệt gọi `/api/*` cùng origin qua Next.js rewrite; riêng stream SSE `/api/v1/events` được Caddy chuyển thẳng sang NestJS (không qua rewrite, tránh bị buffer).

| Lớp | Trách nhiệm | Không được làm |
| --- | --- | --- |
| Transport | Controller, DTO allow-list (từ chối field lạ), exception filter, SSE gateway, header `Server-Timing` | Xây Redis key, quyết định quyền |
| Policy | `PolicyService.can(actor, action, resource)` bám theo bảng RBAC; guard Platform Admin | Rải `if` kiểm tra quyền khắp service |
| Application service | `CreateTask`, `MoveTask`, `AssignTask`, `CompleteSprint`, `SuspendUser`… | Gọi `JSON.SET`/`ZADD` trực tiếp |
| Domain | Entity type, bảng chuyển trạng thái, thuật toán position, mã lỗi | Phụ thuộc Redis |
| Repository | Key builder, đọc theo pipeline, `FCALL`, assert `entity.workspaceId === ctx.workspaceId` sau mỗi lần đọc | Ghi ngoài Function |
| Redis Functions | Library `sprinthub` có `LIB_VERSION`: kiểm tra mọi điều kiện rồi mới ghi | Gọi mạng, chạy quá 5 ms |

Module nghiệp vụ: `auth`, `users`, `workspaces`, `projects`, `tasks`, `sprints`, `labels`, `comments`, `notifications`, `sync`. Admin API không nằm trong repo này (xem "Admin tách repo"); BE chỉ sở hữu các Function admin trong library.

**Quy tắc ranh giới Function (v1.2).** Mọi điều kiện có thể làm hỏng invariant phải được kiểm tra **bên trong** Function, ngay trước lệnh ghi:

- membership và role của actor;
- assignee còn là member;
- `expectedVersion`;
- số admin/owner còn lại;
- idempotency key;
- fencing epoch của job batch.

API vẫn kiểm tra trước để trả lỗi sớm, nhưng **Function mới là nơi quyết định**.

**Không giữ trạng thái trong process.** API và worker không cache membership, session hay quyền trong RAM; mọi thứ đọc từ Redis để thu hồi quyền có hiệu lực ngay.

**Repo và cách làm việc**

| Repo | Nội dung |
| --- | --- |
| `sprinthub-be` (trung tâm) | NestJS API + worker, Redis Functions, `openspec/specs` và `openspec/changes/<change>/contract.md`, `docs/adr`, `docs/design`, `spikes/redis-core`, `AGENTS.md` mô tả quan hệ giữa các repo, script điều phối (`gen:client`…) |
| `sprinthub-fe` | Next.js; `AGENTS.md` ghi "contract sửa ở BE trước"; type sinh từ `openapi.json` bằng `openapi-typescript`. UI thiết kế qua Figma (để sau) |
| `sprinthub-infra` | `base/` + `envs/prod/` (compose, Caddy, `redis.conf`, `image-tags.env`), script deploy/backup/restore drill, E2E Playwright, `make prod-like` |

- Ba repo nằm cạnh nhau trong `SpirntHub/`; mọi session mở ở `sprinthub-be`, agent sang repo bên cạnh khi cần.
- GitHub, public, MIT, secret scan từ commit đầu. Trunk-based: `main` + feature branch ngắn.
- Claude Docs là bản gốc cho tới khi bắt đầu code, sau đó xuất ra `docs/` và repo thành bản gốc.

## Keyspace Redis

Mọi key có prefix `sh:v1:` (prefix cấu hình được xuyên suốt key builder, Functions và ACL để CI dùng riêng). Key gốc có dạng `{entity}:{id}` và **không có sub-key** bên dưới; index dùng tên type riêng có gạch nối, để Search theo prefix và `SCAN` của repair job chỉ chạm vào JSON gốc.

- **ID:** `{prefix}_{ULID}` monotonic (`usr`, `ws`, `prj`, `tsk`, `cmt`, `spr`, `lbl`, `act`, `ntf`, `aud`). ULID lộ thời điểm tạo, chấp nhận được; không dùng ULID để sắp thứ tự chặt giữa process (dùng `seq`/`version`).
- **TTL:** chỉ cho session, idempotency, rate limit, sudo, lock, job, presence. Dữ liệu nghiệp vụ không TTL.
- **Thời gian:** lưu cả ISO (`createdAt`) và epoch ms (`createdAtMs`), ghi cùng lúc.

| Key (sau `sh:v1:`) | Type | Vai trò | Phục vụ query |
| --- | --- | --- | --- |
| `user:{id}` | JSON | Gốc | Profile, login |
| `user-email:{sha256(email)}` | STRING | Unique | Login, chống trùng email |
| `users-by-created` | ZSET | Index | Admin list user (thay `SCAN`) |
| `user-workspaces:{userId}` | SET | Reverse | Workspace selector |
| `user-sessions:{userId}` | SET | Index | Logout-all, suspend |
| `session:{sha256(token)}` | HASH | Ephemeral | Auth mỗi request (TTL trượt 7 ngày, tuyệt đối 30) |
| `workspace:{id}` | JSON | Gốc | Setting |
| `workspaces-by-created` | ZSET | Index | Admin list workspace |
| `workspace-members:{wsId}` | HASH | Gốc membership | Tenant check `userId → role` |
| `workspace-slug:{slug}` | STRING | Unique | Slug |
| `workspace-projects:{wsId}` | SET | Index | Danh sách project |
| `workspace-seq:{wsId}` | STRING | Counter | Delta sync |
| `workspace-changes:{wsId}` | ZSET | Change log | `"{type}:{id}" → seq` |
| `project:{id}` | JSON | Gốc | Project |
| `project-key:{wsId}:{KEY}` | STRING | Unique | Project key |
| `project-task-seq:{projectId}` | STRING | Counter | Issue number |
| `project-tasks:{projectId}` | SET | Index | Repair, thống kê |
| `task:{id}` | JSON | Gốc | Chi tiết task |
| `task-key:{wsId}:{KEY-n}` | STRING | Unique | Permalink theo key |
| `board:{projectId}:{status}` | ZSET | Index | Board, `taskId → position` |
| `backlog:{projectId}` | ZSET | Index | Backlog, `taskId → backlogRank` |
| `user-assigned:{userId}` | SET | Reverse | Task của tôi |
| `sprint:{id}` / `project-sprints:{pid}` / `project-active-sprint:{pid}` / `sprint-tasks:{sid}` | JSON / ZSET / STRING / SET | Gốc + index | Sprint |
| `label:{id}` / `project-labels:{pid}` / `project-label-name:{pid}:{name}` / `label-tasks:{lid}` | JSON / SET / STRING / SET | Gốc + index | Label, filter |
| `comment:{id}` / `task-comments:{taskId}` | JSON / ZSET | Gốc + index | Comment |
| `activity:{id}` / `task-activity:{taskId}` | JSON / ZSET | Gốc + index | Activity |
| `notification:{userId}:{eventId}` / `user-notifications:{userId}` | JSON / ZSET | Gốc + index | Notification (ID tất định theo event, giới hạn N mục) |
| `stream:domain-events` | STREAM | Event log | Worker, realtime |
| `stream:dead-letter` | STREAM | DLQ | Event lỗi quá 3 lần |
| `stream:audit` | STREAM | Audit | Chỉ `sh-maint` được trim |
| `processed:{group}:{eventId}` | STRING | Dedupe | Consumer idempotent (TTL 7 ngày) |
| `idempotency:{actorId}:{key}` | JSON | Ephemeral | `{requestHash, response}`, TTL 24h, ghi trong Function |
| `lock:{job}` / `fence:{job}` | STRING | Lock + epoch | Job batch có fencing |
| `platform-admins` / `platform-settings` | SET / HASH | Gốc | Admin, đăng ký, maintenance |
| `ratelimit:{scope}:{subject}:{window}` | STRING | Ephemeral | Rate limit |
| `meta:migrations` / `job:{id}` | HASH / JSON | Gốc | Migration, maintenance job |

## Entity JSON gốc

JSON gốc là nguồn sự thật; mọi index phải dựng lại được từ đây. Mọi entity có `version` (tăng mỗi lần ghi có hiệu lực) và `schemaVersion` (cho migration).

| Entity | Trường chính | Ghi chú |
| --- | --- | --- |
| User | `email`, `emailNormalized`, `passwordHash` (Argon2id), `displayName`, `avatarUrl`, `disabledAt`, `suspendedBy`, `lastLoginAt` | Quyền Platform Admin **không** nằm ở đây; `passwordHash` không bao giờ ra API |
| Workspace | `name`, `slug`, `ownerId`, `archivedAt`, `suspendedAt`, `suspendedBy` | Membership nằm ở HASH riêng |
| Project | `workspaceId`, `name`, `key` (2–10 ký tự A–Z0–9), `description`, `createdBy`, `archivedAt` | Không đổi `key` khi đã có task (MVP) |
| Sprint | `projectId`, `number`, `name`, `goal`, `status` (PLANNED/ACTIVE/COMPLETING/COMPLETED), `startAt(Ms)`, `endAt`, `completedSummary` | Tối đa 1 ACTIVE mỗi project |
| Label | `projectId`, `name`, `color`, `deletedAt` | Tên unique trong project |
| Comment | `taskId`, `authorId`, `body` (Markdown), `deletedAt` |  |

**Task** là entity phức tạp nhất:

```json
{
  "id": "tsk_01JD8Y...",
  "workspaceId": "ws_01ABC",
  "projectId": "prj_01ABC",
  "number": 42,
  "key": "SHAPI-42",
  "title": "Implement login API",
  "description": "Create **login** and refresh flows",
  "descriptionFormat": "markdown",
  "status": "TODO",
  "priority": "HIGH",
  "assigneeId": "usr_01DEF",
  "assigneeIndexValue": "usr_01DEF",
  "reporterId": "usr_01ABC",
  "sprintId": null,
  "labelIds": ["lbl_01AAA"],
  "position": 1024,
  "backlogRank": 1024,
  "dueAtMs": 0,
  "createdAt": "2026-11-18T08:30:00.000Z",
  "createdAtMs": 1794990600000,
  "deletedAt": null,
  "isDeleted": "false",
  "lastSeq": 318,
  "lastClientMutationId": "01JD8Z3M...",
  "schemaVersion": 1,
  "version": 7
}
```

- `assigneeIndexValue` = `assigneeId` hoặc `"UNASSIGNED"`, vì Search TAG không xử lý `null` gọn.
- `isDeleted` là bản TAG của `deletedAt`, ghi cùng lúc.
- `lastClientMutationId` (mới ở v1.2): retry mang cùng id thì trả `200` với state hiện tại thay vì `409`.
- `description` và `comment.body` là Markdown, tối đa 20.000 ký tự; server lưu nguyên văn, FE render có sanitize.

## Invariants và chiến lược nhất quán

Redis không có foreign key, nên 19 điều dưới đây là “ràng buộc” do ứng dụng tự giữ. `verify-invariants` kiểm tra tất cả và xuất báo cáo.

1. `workspace.ownerId` có membership OWNER; mỗi workspace đúng một OWNER.
2. `project.workspaceId` trỏ tới workspace còn active; `task.workspaceId === project.workspaceId`.
3. Assignee là member tại thời điểm assign (kiểm tra **trong** Function); member bị xóa thì task được unassign.
4. Task active nằm đúng một lần trong `project-tasks` và đúng một ZSET board khớp `task.status`.
5. `ZSCORE(board, taskId) == task.position`; `ZSCORE(backlog, taskId) == task.backlogRank`.
6. Assigned index chỉ có ở user hiện tại.
7. Task đã soft delete không có trong index active và có `isDeleted = "true"`.
8. `version` tăng đơn điệu; event phát tối đa một lần cho mỗi mutation được chấp nhận.
9. `task.key = {project.key}-{task.number}`, `task-key` trỏ đúng task; `number ≤ project-task-seq`.
10. Task `sprintId == null` nằm trong backlog; có `sprintId` thì nằm trong `sprint-tasks` và không có trong backlog.
11. Mỗi project tối đa một sprint ACTIVE, khớp `project-active-sprint`.
12. Mọi `labelId` của task thuộc cùng project và task có trong `label-tasks`.
13. `task.lastSeq ≤ workspace-seq`; seq chỉ tăng.
14. User có `disabledAt` không còn session hợp lệ.
15. `platform-admins` luôn còn ít nhất 1 user active (đếm và gỡ trong cùng Function).
16. Mỗi user và workspace có trong `users-by-created`/`workspaces-by-created`.
17. Idempotency key đã dùng thì response lưu kèm khớp với mutation đã chạy.
18. Chỉ job giữ epoch mới nhất trong `fence:{job}` mới ghi được.
19. Notification chỉ tham chiếu entity, không sao chép nội dung nhạy cảm.

| Đường | Cách làm |
| --- | --- |
| Đồng bộ | Một Function: kiểm tra điều kiện → ghi JSON + index → `INCR workspace-seq` → `ZADD workspace-changes` → `XADD` event → lưu idempotency. `XADD` trong cùng Function chính là transactional outbox |
| Bất đồng bộ | Worker xử lý at-least-once, mọi side effect idempotent |
| Sửa chữa | Verify (dry-run) → báo cáo missing/orphan/wrong-score → apply trong maintenance mode |
| Retry | `Idempotency-Key` bắt buộc cho create và cho mutation do mutation queue gửi lại |

**Atomic không có nghĩa là rollback.** Function không bị client khác xen ngang, nhưng nếu lỗi giữa chừng thì các lệnh đã chạy vẫn còn. Vì vậy Function đọc và kiểm tra mọi thứ trước lệnh ghi đầu tiên, không gọi mạng, và có test lỗi runtime giữa chừng.

| ACID | SQL có sẵn | SprintHub tự làm |
| --- | --- | --- |
| Atomicity | Transaction + rollback | Function nguyên tử, không rollback |
| Consistency | FK, unique, check | Invariant trong Function + verifier |
| Isolation | Mức cô lập | Redis thực thi tuần tự một luồng |
| Durability | WAL fsync mỗi commit | AOF `everysec`: có thể mất \~1 s |

## Luồng nghiệp vụ

Mỗi luồng ghi là một `FCALL`. Function tự kiểm tra quyền, version và idempotency rồi mới ghi, nên API chỉ còn việc validate DTO và dịch mã lỗi.

### Create task (`sh_create_task`)

```text
KEYS: idempotency, workspace-members, project, project-task-seq, workspace-seq, ...
1. GET idempotency → có rồi: cùng requestHash trả response cũ, khác hash trả IDEMPOTENCY_KEY_REUSED
2. HGET workspace-members actor → không phải member: NOT_FOUND
3. project active? assignee (nếu có) là member? label cùng project? sprint chưa COMPLETED?
   --- chưa có lệnh ghi nào trước dòng này ---
4. n = INCR project-task-seq; SET task-key {KEY}-{n} NX
5. seq = INCR workspace-seq
6. JSON.SET task (number, key, version 1, lastSeq seq)
7. SADD project-tasks; ZADD board:TODO; SADD user-assigned; SADD label-tasks; ZADD backlog | SADD sprint-tasks
8. ZADD workspace-changes; XADD stream:domain-events (seq, clientMutationId, requestId, eventVersion)
9. SET idempotency {requestHash, response} EX 86400
```

Số `n` có thể bị bỏ qua nếu Function lỗi sau bước 4; không hứa số liên tục.

### Move / reorder (`sh_move_task`)

Trạng thái cố định, chỉ các cạnh sau hợp lệ (sai thì `422 INVALID_STATUS_TRANSITION`; reorder cùng cột luôn hợp lệ):

| Từ | Sang |
| --- | --- |
| TODO | IN\_PROGRESS |
| IN\_PROGRESS | IN\_REVIEW, TODO |
| IN\_REVIEW | DONE, IN\_PROGRESS |
| DONE | IN\_PROGRESS |

Thứ tự dùng số nguyên cách quãng `STEP = 1024`:

- Chèn cuối cột: `max + 1024`. Chèn đầu cột: `min − 1024`.
- Chèn giữa `a < b`: `floor((a + b) / 2)` khi `b − a ≥ 2`.
- Hết khoảng hoặc `|x| > 2^50`: rebalance cả cột thành `i × 1024`, trong một Function nếu cột ≤ 500 task (con số này phải đo, vượt 5 ms thì hạ xuống).
- Rebalance **không** tăng `version`, chỉ tăng `lastSeq`, và phát một event `BOARD_REBALANCED`.

Điều kiện trong Function:

1. Actor là member.
2. Task active.
3. `expectedVersion` khớp, hoặc `clientMutationId == lastClientMutationId` (retry của chính mình: trả `200` với state hiện tại).
4. Chuyển trạng thái hợp lệ.
5. `beforeTaskId`/`afterTaskId` cùng project, cùng cột đích, chưa xóa.

### Assign (`sh_assign_task`)

Trong cùng Function: `HGET workspace-members newAssignee` (không còn là member thì `422`) → kiểm tra version → cập nhật `assigneeId`, `assigneeIndexValue` → `SREM`/`SADD user-assigned` → event. Đưa kiểm tra membership vào Function là cách sửa **write skew** của v1.1: trước đây “remove member” có thể chạy chen giữa lúc API kiểm tra và lúc ghi.

### Remove member và job batch

1. Function: `HDEL workspace-members`, `SREM user-workspaces`, audit, event `MEMBER_REMOVED`. Quyền bị thu hồi ngay từ đây.
2. Worker lấy lock `lock:unassign:{ws}:{user}` kèm `epoch = INCR fence:unassign:{ws}:{user}`.
3. Mỗi batch 100 task gọi `FCALL` kèm epoch. Function từ chối epoch cũ (fencing) và **kiểm tra lại**: user vẫn không phải member và vẫn là assignee thì mới unassign. Nếu user đã được mời lại thì bỏ qua.
4. Tiến độ lưu trong `job:{id}`; cảnh báo nếu job kẹt quá 15 phút.

Cùng mẫu áp dụng cho rebalance cột lớn, complete sprint (> 200 task), apply repair và trim stream.

### Sprint

- **Start**: `SET project-active-sprint {sid} NX`; thất bại thì `409 SPRINT_ALREADY_ACTIVE`.
- **Complete**: task chưa DONE chuyển sang sprint PLANNED khác hoặc về backlog; task DONE ở lại để báo cáo; lưu `completedSummary`.
- **Board khi có sprint ACTIVE**: `ZINTER 2 board:{p}:{status} sprint-tasks:{sid} WEIGHTS 1 0` (giữ score, chỉ lấy task thuộc sprint).

### Mutation queue phía client

1. Mỗi task có một hàng đợi riêng; mỗi task chỉ có tối đa 1 request đang bay.
2. UI optimistic ngay. Mutation sau chờ và lấy `expectedVersion` từ response của mutation trước; nhiều move đang chờ thì gộp thành trạng thái cuối.
3. Mỗi mutation có `X-Client-Mutation-Id` và `Idempotency-Key`. Event quay về mang id của chính tab thì bỏ qua.
4. **Chỉ áp** dữ liệu từ server khi `version` ≥ bản local; bỏ event có `seq ≤ lastSeq`.
5. Gặp `409` do người khác: xóa các mutation phía sau của task đó, rollback, refetch, báo cho user.
6. Gặp `503` hoặc timeout: retry với **cùng** key, backoff 200 → 400 → 800 ms có jitter, tối đa 3 lần.

## Query, Search và phân trang

Mỗi request đọc phải nằm trong ngân sách round trip cố định. Redis đơn luồng nên một lệnh chậm làm chậm mọi người: không bao giờ `KEYS`/`SCAN` trong request, không `SMEMBERS` trên SET lớn không giới hạn.

| Màn hình | Cách đọc | Round trip |
| --- | --- | --- |
| Guard mọi request | Pipeline: `HGETALL session` + `INCR ratelimit` + `HGET workspace-members` | 1 |
| Board | Pipeline 4×`ZRANGE` (×`ZINTER` khi có sprint) → `JSON.MGET` chỉ các path của thẻ: `$.key`, `$.title`, `$.priority`, `$.assigneeId`, `$.dueAtMs`, `$.labelIds`, `$.version` (không lấy description) | 2 |
| Chi tiết task | `JSON.GET` + `ZREVRANGE task-comments` + `task-activity` (pipeline) | 1–2 |
| Backlog | `ZRANGE backlog` theo cursor → `JSON.MGET` | 2 |
| Tra theo key | `GET task-key` → `JSON.GET` | 2 |
| Filter label | `SINTER label-tasks:A label-tasks:B` giao với board/backlog | 2 |
| Dashboard | `ZCARD` mỗi cột (pipeline) | 1 |
| Delta sync | `ZRANGEBYSCORE workspace-changes (sinceSeq +inf LIMIT 0 500` → `JSON.MGET` → lọc theo quyền | 2 |
| Admin list | `ZREVRANGEBYSCORE users-by-created` theo cursor | 2 |

**Phân trang:** luôn dùng cursor opaque `(score, id)`, không offset; `limit` tối đa 100 (delta 500).

**Redis Search** (P1) index trên task JSON, tên có version để đổi schema bằng alias:

```redis
FT.CREATE idx:sh:v1:tasks ON JSON PREFIX 1 sh:v1:task: SCHEMA
  $.workspaceId AS workspaceId TAG  $.projectId AS projectId TAG
  $.status AS status TAG  $.priority AS priority TAG
  $.assigneeIndexValue AS assignee TAG  $.sprintId AS sprintId TAG
  $.labelIds[*] AS labelId TAG  $.key AS key TAG  $.isDeleted AS isDeleted TAG
  $.title AS title TEXT WEIGHT 2  $.description AS description TEXT
  $.createdAtMs AS createdAtMs NUMERIC SORTABLE  $.dueAtMs AS dueAtMs NUMERIC SORTABLE
```

- Query luôn có `@workspaceId:{$ws} @isDeleted:{false}`, truyền tham số bằng `PARAMS` + `DIALECT 2`; không tin `workspaceId` từ client.
- Kiểm tra query bằng `FT.EXPLAIN`/`FT.PROFILE`; cân nhắc `FILTER` để không index task đã xóa (xác minh trên bản Redis đã pin).
- Tìm kiếm dạng `%xyz%` không được hỗ trợ tốt; ghi giới hạn này vào UX.

## Auth, phân quyền và Platform Admin

Quyền luôn do server suy ra từ session và membership; client không bao giờ set được `workspaceId`, `projectId`, `version`, `key`, `number`, `seq` hay role.

**Session**

- Token ngẫu nhiên 256-bit trong cookie `HttpOnly; Secure; SameSite=Lax`. Redis lưu `session:{sha256(token)}`, TTL trượt 7 ngày, tuyệt đối 30 ngày.
- Đổi token khi login và khi đổi quyền. Không dùng JWT; không có `/auth/refresh` riêng (TTL trượt đã thay). Không cần `SESSION_SECRET` vì token là opaque và chỉ được hash.
- Same-origin qua Next.js rewrite; mutation cần header CSRF. Mọi request kiểm tra `user.disabledAt`.
- Register trả cùng một response dù email đã tồn tại hay chưa. Đổi mật khẩu (`POST /users/me/password`) cần mật khẩu cũ + sudo và thu hồi mọi session khác.

**Tenant isolation:** xác thực actor → đọc entity, lấy `workspaceId` thật → kiểm tra membership → kiểm tra quyền → repository assert lại `workspaceId` (lớp thứ hai thay cho row-level security) → Function kiểm tra lần cuối. Không phải member thì `404`; là member nhưng thiếu quyền thì `403`.

| Hành động | Owner | Admin | Member | Platform Admin |
| --- | --- | --- | --- | --- |
| Xem workspace/project/task | ✓ | ✓ | ✓ | Chỉ metadata |
| Sửa setting, thêm/xóa Member | ✓ | ✓ | — | — |
| Xóa Admin, đổi role, chuyển Owner | ✓ | — | — | Khôi phục Owner (sudo + audit) |
| Tạo/archive project, quản lý sprint | ✓ | ✓ | — | — |
| Tạo/sửa/move/assign task, label, comment | ✓ | ✓ | ✓ | — |
| Xóa task | ✓ | ✓ | Task mình tạo | — |
| Suspend user/workspace, revoke session | — | — | — | ✓ (sudo) |

**Platform Admin**

- Quyền nằm ở `platform-admins` (SET), không nằm trong user JSON. Admin đầu tiên tạo bằng CLI `scripts/admin/grant.ts`; không có luồng “user đầu tiên thành admin”.
- Admin API nằm ở repo `sprinthub-admin-service` (route `/admin-api/v1/*`), không nằm trong `sprinthub-be`. Mọi route qua guard Platform Admin; không phải admin thì `404`. Xem mục "Admin tách repo" bên dưới.
- Hành động nhạy cảm cần sudo (nhập lại mật khẩu, hiệu lực 10 phút). Mọi request admin ghi `stream:audit`.
- Gỡ admin cuối cùng bị từ chối trong Function (`409 LAST_PLATFORM_ADMIN`). Maintenance mode chặn mutation của user thường khi apply rebuild/migration.

**Admin tách repo (v1.4)**

| Thành phần | Repo | Vai trò |
| --- | --- | --- |
| Admin console | `sprinthub-admin-ui` | Màn hình users, workspaces, health, jobs, audit, settings, danh sách Platform Admin |
| Admin API | `sprinthub-admin-service` | NestJS, prefix `/admin-api/v1`, guard Platform Admin, sudo, audit |
| Library Function | `sprinthub-be` | Sở hữu library `sprinthub`, kể cả các Function admin (`sh_suspend_user`, `sh_grant_admin`, `sh_revoke_admin`, `sh_set_platform_setting`, `sh_transfer_owner`, job verify/rebuild) |

- **Ghi chỉ qua Function.** `sprinthub-admin-service` dùng Redis user `sh-admin-svc`: đọc trực tiếp các key cần cho màn hình (user, workspace, index `*-by-created`, `INFO`, `XINFO`, `FT.INFO`), nhưng mọi thao tác ghi gọi `FCALL` tới library do BE sở hữu. Invariant chỉ được giữ ở một chỗ (ADR-009, ADR-015).
- **Đề xuất cho phần đăng nhập (cần xác nhận khi làm P1):** cùng domain, phân đường dẫn bằng Caddy: `/admin` → admin-ui, `/admin-api/*` → admin-service. Admin đăng nhập bằng luồng login của `sprinthub-be` (dùng chung cookie session), admin-service đọc `session:*` và kiểm tra `platform-admins` trước mọi request.
- **Version library:** library có `LIB_VERSION`; admin-service kiểm tra version lúc khởi động (readiness fail nếu không khớp). Khi library đổi, deploy BE trước, admin-service sau.
- **Deploy:** thêm 2 image (`admin-ui`, `admin-service`) vào `sprinthub-infra/envs/prod/image-tags.env`, cùng luồng PR + kiểm tra tạm như các image khác.

**Rate limit** (fixed window `INCR` + `EXPIRE NX`, trả `429` + `Retry-After` + header RateLimit; chỉ lưu hash IP):

| Scope | Giới hạn | Key |
| --- | --- | --- |
| Login theo IP (mọi email) | 20 / 15 phút | `ratelimit:login-ip:{ipHash}` |
| Login theo tài khoản (mọi IP) | 5 / 15 phút | `ratelimit:login-acct:{emailDigest}` |
| Register | 3 / giờ / IP | `ratelimit:register:{ipHash}` |
| Ghi | 120 / phút / user | `ratelimit:write:{userId}` |
| Search, delta sync | 60 / phút / user | `ratelimit:read-heavy:{userId}` |
| Admin | 60 / phút | `ratelimit:admin:{userId}` |

Fixed window cho phép gấp đôi quanh biên cửa sổ; chấp nhận ở MVP, sliding window để P2.

**Redis ACL:** `sh-app` và `sh-worker` giới hạn trong `~sh:v1:*` và `-@dangerous`; `sh-maint` cho migration, rebuild và trim audit; `sh-admin-svc` cho `sprinthub-admin-service` (đọc `~sh:v1:*`, ghi chỉ qua `FCALL`); `sh-admin` chỉ dùng thủ công. Mục tiêu P1: `sh-app` chỉ ghi qua `FCALL` và không `XDEL`/`XTRIM` được `stream:audit` (xác minh cú pháp ACL selector trên bản đã pin).

**Song ngữ EN/VI**

- BE không dịch: lỗi trả `code` + `params` (ví dụ `TASK_VERSION_CONFLICT`, `{currentVersion: 6}`), FE dịch theo catalog `en`/`vi`.
- User có field `locale` (`en` | `vi`); chưa đăng nhập thì dùng cookie hoặc `Accept-Language`.
- Chỉ trang landing có prefix URL (`/en`, `/vi`); trong app lấy ngôn ngữ từ profile.
- Notification chỉ lưu tham chiếu, câu chữ được render lúc hiển thị theo ngôn ngữ người xem; email (P2) gửi theo `user.locale`.
- Nội dung người dùng (title, comment) không dịch. Danh sách `code` lỗi nằm trong contract.

## API contract

REST `/api/v1`. Contract gồm `contract.md` theo OpenSpec trong repo BE (cho người đọc) và `openapi.json` sinh tự động từ NestJS; FE sinh type bằng `openapi-typescript`, CI báo lỗi nếu FE lệch spec. Chỉ thay đổi kiểu bổ sung: không đổi tên hay xóa field; thay đổi phá vỡ thì ra `/v2` chạy song song.

| Nhóm | Endpoint chính |
| --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/logout`, `/auth/logout-all`, `/auth/sudo` |
| User | `GET/PATCH /users/me` (chỉ `displayName`, `avatarUrl`), `POST /users/me/password`, `GET /users/me/sessions` |
| Workspace | `GET/POST /workspaces`, `GET/PATCH /workspaces/{wid}`, `GET/POST /workspaces/{wid}/members`, `PATCH/DELETE /workspaces/{wid}/members/{uid}`, `POST /workspaces/{wid}/leave`, `POST /workspaces/{wid}/transfer-ownership` |
| Project | `GET/POST /workspaces/{wid}/projects`, `GET/PATCH /projects/{pid}` |
| Task | `GET /projects/{pid}/board`, `GET/POST /projects/{pid}/tasks`, `GET/PATCH/DELETE /tasks/{tid}`, `PATCH /tasks/{tid}/move`, `/assignee`, `/sprint`, `/backlog-rank`, `PUT /tasks/{tid}/labels`, `GET /workspaces/{wid}/tasks/by-key/{key}` |
| Sprint, label | `GET/POST /projects/{pid}/sprints`, `PATCH /sprints/{sid}`, `POST /sprints/{sid}/start`, `/complete`, `GET /projects/{pid}/backlog`, `GET/POST /projects/{pid}/labels`, `PATCH/DELETE /labels/{lid}` |
| Khác | `GET /projects/{pid}/search`, `/stats`, `GET/POST /tasks/{tid}/comments`, `GET /tasks/{tid}/activity`, `GET /notifications`, `PATCH /notifications/{nid}/read`, `GET /workspaces/{wid}/changes?sinceSeq=` |
| Admin (thuộc `sprinthub-admin-service`, prefix `/admin-api/v1`) | `/users`, `/users/{uid}/suspend\|reactivate\|revoke-sessions`, `/workspaces`, `/platform-admins`, `/settings`, `/health`, `/jobs`, `/audit` |

**Header:** mọi PATCH bắt buộc `expectedVersion` trong body. Mutation nhận `Idempotency-Key` (bắt buộc cho create và cho mutation do queue gửi lại) và `X-Client-Mutation-Id`. Response kèm `seq`, `requestId` và `Server-Timing`.

**Cache:** `/api/*` và mọi trang SSR có đăng nhập trả `Cache-Control: no-store`. Chỉ asset có hash được `public, max-age=31536000, immutable`.

| Mã | Khi nào |
| --- | --- |
| `400` / `422` | Sai cấu trúc / sai nghiệp vụ: `INVALID_STATUS_TRANSITION`, `IDEMPOTENCY_KEY_REUSED`, assignee không phải member |
| `401` | Thiếu session, `USER_SUSPENDED` |
| `403` | Member thiếu quyền, `SUDO_REQUIRED`, `REGISTRATION_DISABLED` |
| `404` | Không tồn tại **hoặc** không phải member; route admin khi không phải admin |
| `409` | `TASK_VERSION_CONFLICT` (kèm `currentVersion`), `SPRINT_ALREADY_ACTIVE`, `LAST_PLATFORM_ADMIN` |
| `410` | `SYNC_CURSOR_EXPIRED` |
| `423` | `WORKSPACE_SUSPENDED` |
| `429` | Rate limit, kèm `Retry-After` |
| `503` | Redis không sẵn sàng, timeout (kết quả không rõ: client retry với cùng key), `MAINTENANCE` |

Error envelope: `{ error: { code, message, details }, requestId }`; không trả stack trace, Redis key hay secret.

## Realtime, Streams và delta sync

Lưu trước, đẩy sau: dữ liệu đã commit trong Function mới là sự thật, realtime chỉ là tối ưu. Mất một tín hiệu Pub/Sub không mất dữ liệu, vì client tự kéo delta.

**Event envelope** (trong `stream:domain-events`, một stream chung):

```json
{ "eventId": "evt_01...", "eventVersion": 1, "type": "TASK_MOVED",
  "workspaceId": "ws_01ABC", "projectId": "prj_01ABC", "taskId": "tsk_01ABC",
  "actorId": "usr_01DEF", "entityVersion": 8, "seq": 319,
  "clientMutationId": "01JD8Z...", "requestId": "req_01ABC",
  "occurredAt": "2026-11-18T10:00:00.000Z", "payload": { "from": "TODO", "to": "IN_PROGRESS" } }
```

**Kênh realtime là SSE.** Client mở `GET /api/v1/events?ws={id}` (một stream cho mỗi workspace đang mở), Caddy chuyển thẳng sang NestJS và tắt buffer. Mỗi SSE event có `id:` = `seq` của workspace; heartbeat comment mỗi 25 s. API `PUBLISH sh:v1:ws:{id} {seq}` ngay sau khi `FCALL` thành công, gateway SSE nhận qua Pub/Sub rồi đẩy xuống client. Nếu API chết giữa `FCALL` và `PUBLISH`, client vẫn bắt kịp nhờ `Last-Event-ID`.

**Worker (consumer group):**

1. `XREADGROUP` nhận event.
2. `SET processed:{group}:{eventId} NX` → đã xử lý rồi thì chỉ `XACK`.
3. Tạo notification với ID tất định `notification:{userId}:{eventId}`; kiểm tra quyền người nhận tại thời điểm gửi.
4. `XACK` sau khi xong. Crash trước ack thì `XAUTOCLAIM` lấy lại.
5. Số lần giao > 3 thì `XADD stream:dead-letter` rồi `XACK`; admin xem và replay thủ công.

| Event | Người nhận notification |
| --- | --- |
| `TASK_ASSIGNED` | Assignee mới |
| `COMMENT_CREATED` | Assignee, reporter, người đã comment (trừ tác giả) |
| `TASK_MOVED` sang IN\_REVIEW/DONE | Reporter |
| `SPRINT_STARTED` / `SPRINT_COMPLETED` | Không gửi notification, chỉ realtime |

Notification chỉ lưu tham chiếu (taskId, loại, actor); title và quyền được đọc lúc hiển thị. Mỗi user giữ tối đa 500 mục (`ZREMRANGEBYRANK`).

**Delta sync:**

1. Mọi mutation chạy `seq = INCR workspace-seq` và `ZADD workspace-changes seq "{type}:{id}"`. Mỗi entity chỉ chiếm một entry (seq mới nhất).
2. Khi SSE rớt, trình duyệt tự kết nối lại và gửi `Last-Event-ID` = seq cuối đã nhận; server trả bù các thay đổi từ đó (đã lọc theo quyền hiện tại) ngay trên stream.
3. Cursor cũ hơn phần còn giữ trong `workspace-changes` thì server gửi event `resync`; client gọi `/changes` hoặc refetch toàn bộ (`410` nếu gọi `/changes`).
4. `GET /workspaces/{wid}/changes?sinceSeq=` vẫn có cho tab vừa mở lại hoặc khi cần kéo theo trang.
5. Tự reconnect của trình duyệt dùng giá trị `retry:` do server gửi (ngẫu nhiên 1–5 s) để mỗi lần deploy không thành bão reconnect. Khi shutdown, API đóng stream có kiểm soát. Mỗi lần deploy stream bị đứt là bình thường.

| Dữ liệu | Retention |
| --- | --- |
| `stream:domain-events` | `XTRIM MINID` 7 ngày, chỉ phần mọi group đã ACK |
| `workspace-changes` | 10.000 entry hoặc 7 ngày |
| Activity | Không TTL |
| `stream:audit` | 180 ngày |
| Notification đã đọc | 90 ngày |

**Chuỗi rủi ro cần canh:** worker chết → stream không được trim → RAM tăng → `noeviction` từ chối ghi → **mọi mutation hỏng** (vì `XADD` nằm trong mọi Function). Cảnh báo khi event pending cũ nhất quá 10 phút, khi consumer lag vượt ngưỡng, và khi dead-letter có entry.

## Persistence, backup, Redis client và deploy

Dữ liệu chỉ bền tới mức cấu hình cho phép: với `appendfsync everysec`, `200 OK` được trả trước khi fsync, nên crash có thể mất khoảng 1 giây ghi cuối.

```conf
appendonly yes
appendfsync everysec      # đo so với "always" rồi chốt
aof-timestamp-enabled yes # cho khôi phục về thời điểm (xác minh trên bản đã pin)
save 900 1
maxmemory 512mb
maxmemory-policy noeviction
```

`noeviction` là bắt buộc vì đây là database, không phải cache: LRU sẽ âm thầm xóa dữ liệu nghiệp vụ.

| Chủ đề | Thiết kế |
| --- | --- |
| RPO / RTO | Crash: theo kết quả đo (`always` = 0, `everysec` ≤ 1 s), khởi động lại < 1 phút. VM bị Oracle thu hồi: mất ≤ 24 h, dựng lại từ repo infra + backup trong 15–30 phút |
| Backup | `BGSAVE` hằng ngày và trước mỗi deploy; RDB + thư mục AOF được **mã hóa rồi đẩy lên Cloudflare R2** (khác nhà cung cấp với Oracle); khóa mã hóa nằm trong GitHub Environment secrets, không nằm cạnh backup |
| Ghi sai | AOF chép lỗi một cách trung thành; khôi phục bằng `redis-check-aof --truncate-to-timestamp` hoặc backup ngày trước |
| Restore drill | Chạy **trên VM prod**, khôi phục vào một Redis tạm (container riêng, port riêng), chạy verify-invariants rồi xóa. Hằng tuần và trước migration lớn; fail thì cảnh báo. Backup prod không bao giờ vào runner CI |
| Capacity | VM 2 OCPU / 12 GB. Task \~1,5 KB, 10.000 task + comment + activity + index ≈ 100–150 MB (giả định, phải đo bằng `MEMORY USAGE`); `maxmemory` ≥ 2× dataset, còn dư cho fork và Redis tạm của restore drill |
| Host | `vm.overcommit_memory=1`, tắt transparent huge pages, swap bằng RAM; đặt trong cloud-init để dựng lại VM là có ngay |
| Tải | Khoảng 1–4 req/s quy mô demo, đỉnh ×3; một node dư sức. SPOF (Redis, VM, API) được chấp nhận |

**Redis client policy** (mới ở v1.2):

- Timeout mỗi lệnh khoảng 200 ms (chỉnh theo p99 đo được); tắt hoặc giới hạn offline queue, để mất kết nối thì fail nhanh với `503`.
- Chỉ retry lệnh đọc, tối đa 2 lần, backoff + jitter. **Không bao giờ retry mù `FCALL`**: timeout có nghĩa là “không rõ”, trả `503` để client retry với cùng `Idempotency-Key`.
- Kết nối riêng cho: request, subscriber Pub/Sub, `XREADGROUP BLOCK`, và job admin.
- Reconnect có backoff + jitter; readiness fail khi Redis hoặc `LIB_VERSION` không đúng.

**Functions và migration:**

- Library `sprinthub` load bằng `FUNCTION LOAD REPLACE` khi deploy; chữ ký giữ tương thích ngược (hoặc version tên hàm); API và worker deploy cùng nhau.
- Migration theo **expand → migrate → contract**: code đọc được cả `schemaVersion` cũ và mới, bỏ qua field lạ, không đổi tên field trong một bước. Nhờ vậy rollback không gãy.
- Runner ghi `meta:migrations`, chạy idempotent theo batch. Đổi Search schema thì tạo index mới, chờ `percent_indexed = 1`, rồi chuyển alias.

**Deploy:**

Luồng **local → prod**, chi phí $0. Không có dev hay staging chạy lâu dài; các kiểm tra mà staging thường gánh được chuyển vào CI (tạm thời) và vào chế độ `prod-like` ở local.

| Bước | Ở đâu | Việc gì |
| --- | --- | --- |
| Phát triển | Local | Chạy từ source + Docker Compose, dữ liệu seed |
| Merge `main` (BE/FE) | GitHub Actions | Lint, typecheck, unit, integration (mỗi job một Redis riêng), secret scan, build image **multi-arch** (amd64 + arm64) tag theo SHA, push GHCR, **tự mở PR** đổi tag ở `sprinthub-infra/envs/prod/image-tags.env` |
| Kiểm tra PR | GitHub Actions (tạm thời) | Dựng toàn bộ stack bằng compose với đúng các image đó, seed, chạy migration + `FUNCTION LOAD` + E2E Playwright (EN và VI), rồi xóa. Phải xanh mới được merge |
| Thử tay | Local | `make prod-like SHA=<tag>` kéo đúng image từ GHCR và chạy bằng compose |
| Deploy | Oracle Always Free VM (2 OCPU / 12 GB, Singapore) | Bạn duyệt tay PR trong GitHub Environment `production`, merge thì job deploy chạy |

- Caddy: TLS 1.3, HTTP/2, brotli, chứng chỉ tự gia hạn (ACME), HSTS; domain DuckDNS (mua domain riêng để P2). Redis không mở port ra Internet.
- Secret (Redis ACL, khóa SSH deploy, khóa mã hóa backup, token DuckDNS) nằm trong GitHub Environment secrets; job deploy ghi ra `.env` trên VM. Chuyển sang SOPS + age khi số secret tăng (P2).
- Quan sát: log JSON qua `docker logs`, trang health của admin console, một dịch vụ uptime check miễn phí ping `/health/ready`, cron trên VM cảnh báo khi Redis vượt 70% RAM, backup thất bại, hoặc event pending cũ hơn 10 phút. Grafana/Sentry để P2.
- Health: `/health/live` và `/health/ready`; graceful shutdown xả request đang chạy và đóng stream SSE có kiểm soát.
- Oracle dùng gói Free thuần (không nâng Pay-As-You-Go). VM có thể bị thu hồi khi rảnh: dựng lại bằng cloud-init + repo infra + backup R2, thử quy trình này ít nhất một lần. Dự phòng khi Oracle hết máy: máy nhà + Cloudflare Tunnel.

**Quy trình deploy** (GitHub Actions + SSH + Compose):

1. PR đổi tag ở `envs/prod` đã xanh bước kiểm tra tạm và được bạn duyệt. Mỗi lần deploy là một PR, nên lịch sử deploy nằm trong Git.
2. Job deploy SSH vào VM bằng user `deploy`.
3. `BGSAVE` và đẩy backup mã hóa lên R2 trước khi đổi bất cứ thứ gì.
4. Chạy migration bước expand bằng Redis user `sh-maint`.
5. `FUNCTION LOAD REPLACE` library mới (tương thích ngược với code cũ).
6. `docker compose pull && docker compose up -d` cho `api` và `worker` cùng lúc, rồi `web`.
7. Health gate: `/health/ready` phải đạt trong 60 s (Redis + `LIB_VERSION` đúng).
8. Không đạt thì tự quay về tag trước. Rollback thủ công = PR đổi tag về SHA cũ.

## Testing và ADR

Mock Redis chỉ dùng cho unit test; concurrency, persistence, Search và ACL phải test trên Redis thật, mỗi job CI một Redis riêng. Test E2E chờ theo điều kiện, không dùng `sleep` cố định; test flaky bị sửa ngay, không giấu sau auto-retry.

| Tầng | Phạm vi |
| --- | --- |
| Unit | Policy, bảng chuyển trạng thái, thuật toán position, key builder, DTO, map mã lỗi |
| Integration | Từng Function (kể cả lỗi runtime giữa chừng), repository, Search, Streams, ACL |
| Concurrency | Register, create, move, assign, remove member, gỡ admin chạy song song |
| E2E (Playwright) | Login → project → task → kéo → reload → realtime → logout |
| Vận hành | Restart, kill đột ngột, restore, rebuild index, worker chết, Redis OOM, load test tìm điểm p99 vọt |

| ID | Tình huống then chốt | Kỳ vọng |
| --- | --- | --- |
| T-001 | 2 request register cùng email song song | Đúng 1 tài khoản |
| T-002 | 1 IP thử 50 email khác nhau | `429` theo IP |
| T-003 | User workspace khác mở task theo ID | `404` |
| T-004 | 50 create task song song | 50 issue number khác nhau |
| T-005 | 2 client move cùng version | 1 thành công, 1 `409`, task ở đúng 1 cột |
| T-006 | Cùng tab kéo 2 lần liên tiếp | Cả 2 thành công, không `409` |
| T-007 | Assign trong lúc remove member chạy | Không task nào giao cho non-member |
| T-008 | `FCALL` timeout rồi client retry cùng key | Đúng 1 task, 1 event |
| T-009 | Cùng key, khác payload | `422 IDEMPOTENCY_KEY_REUSED` |
| T-010 | Job batch “zombie” có epoch cũ | Bị Function từ chối |
| T-011 | Event có `seq ≤ lastSeq` đến muộn | Client bỏ qua |
| T-012 | Rebalance cột | Thứ tự giữ nguyên, version không đổi, client khác không bị `409` |
| T-013 | Event lỗi 4 lần | Vào dead-letter, không chặn event sau |
| T-014 | Worker crash trước `XACK` | Không trùng notification |
| T-015 | Hai admin gỡ nhau cùng lúc | Còn ít nhất 1 admin |
| T-016 | Suspend user đang login 2 thiết bị | Mọi session và stream SSE bị đóng |
| T-017 | `sh-app` gọi `FLUSHALL`/`KEYS` | `NOPERM` |
| T-018 | Description chứa `<script>` | Không chạy script |
| T-019 | Redis `maxmemory` rất nhỏ | API trả `503` có kiểm soát |
| T-020 | Index bị làm hỏng có chủ đích | Verify phát hiện, rebuild sửa được |
| T-021 | Đọc board 200 task | ≤ 2 round trip Redis |

| ADR | Quyết định | Giá phải trả |
| --- | --- | --- |
| 001 | Redis 8 là database duy nhất | Tự xây join, unique, transaction; không kết luận Redis tốt hơn SQL |
| 002 | JSON gốc + index SET/ZSET dựng lại được | Ghi nhiều key, cần Function |
| 003 | Một node trước Cluster | SPOF; cần RTO rõ |
| 004 | Streams cho event bền, Pub/Sub chỉ là tín hiệu | Client phải bắt kịp bằng seq |
| 005 | Số nguyên cách quãng 1024 thay LexoRank | Phải có rebalance |
| 006 | Key gốc không có sub-key | Đổi tên index so với v1.0 |
| 007 | Platform Admin tách khỏi tenant, không đọc nội dung (v1.4: chạy ở repo admin riêng) | Thêm guard, audit, sudo |
| 008 | Một stream chung + `workspace-seq` | Mọi Function phải ghi seq |
| 009 | Mọi điều kiện invariant nằm trong Function | Function dài hơn, phải khai báo đủ KEYS |
| 010 | Idempotency ghi trong Function, `FCALL` không retry mù | Client phải luôn gửi key |
| 011 | Luồng local → prod, chi phí $0: CI tạm thời thay staging, prod trên 1 VM Oracle Free, SSH + Compose, tag SHA trong `sprinthub-infra/envs/prod`; không Kubernetes/Argo CD. Đã cân nhắc: VPS DigitalOcean/Vultr, Render, k3s + Argo CD, 4 môi trường | Không có nơi chạy lâu dài trên dữ liệu gần thật; VM có thể bị thu hồi; vài giây downtime mỗi lần deploy |
| 012 | Realtime bằng SSE thay WebSocket, `Last-Event-ID` = `seq` | Chỉ một chiều; muốn presence hai chiều thì dùng REST heartbeat hoặc đổi sau |
| 013 | 3 repo, `sprinthub-be` làm trung tâm; contract = OpenSpec + OpenAPI sinh tự động | E2E phải kéo image từ nhiều repo, phải giữ contract đồng bộ |
| 014 | Song ngữ EN/VI, BE trả `code` + `params`, FE dịch | FE giữ catalog 2 ngôn ngữ, E2E chạy cả hai |
| 015 | Platform Admin tách 2 repo; admin-service đọc Redis trực tiếp nhưng **chỉ ghi qua Function** của library `sprinthub` (BE sở hữu) | Hai service cùng gọi library: phải version Function, giữ chữ ký tương thích ngược, deploy admin-service sau BE khi library đổi |

Nghiên cứu, đối chiếu và nguồn: Nghiên cứu thiết kế
