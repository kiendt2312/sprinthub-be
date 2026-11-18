## Context

Thiết kế v1.6 (`docs/design/design.md`) đặt mọi thao tác ghi nhiều key vào Redis
Functions và mọi điều kiện invariant vào trong Function (ADR-009, ADR-010). Chưa có
dòng code nào chứng minh điều này chạy đúng và đủ nhanh trên Redis 8. Spike làm việc
đó với phạm vi nhỏ nhất: workspace, project, task, board của một project.

## Goals / Non-Goals

**Goals:**
- `sh_create_task` cấp issue key không trùng khi 50 request chạy song song.
- `sh_move_task` cho đúng 1 thành công, 1 `TASK_VERSION_CONFLICT` khi 2 client move
  cùng version; task luôn nằm đúng 1 cột (invariant 4, 5); gửi lại nguyên lệnh đã
  thành công nhận đúng response cũ.
- Retry cùng `Idempotency-Key` không tạo task thứ hai, không tăng seq hay phát event
  lần hai; cùng key khác payload bị từ chối (invariant 8, 13, 17).
- Membership được Function kiểm tra tại thời điểm ghi, theo cả hai thứ tự create/remove
  (invariant 3).
- Bộ KEYS của workspace khác không vượt qua được kiểm tra quyền hay replay.
- Mọi nhánh từ chối không ghi gì; lỗi sau khi đã ghi để lại phần ghi dở và bị phát hiện
  (verifier cho index, assertion riêng cho event và idempotency).
- Rebalance giữ nguyên thứ tự, không đổi `version` của task khác, chỉ một event.
- Dữ liệu và library còn nguyên sau `docker restart`; sau `kill -9`, mỗi task phục hồi
  có đủ side effect; đo số ghi đã ACK bị mất với `everysec` và `always`.
- Số đo: p50/p99/max thời gian chạy phía server mỗi Function, p99 phía client,
  `MEMORY USAGE` của một task JSON và các index.

**Non-Goals:**
- NestJS, HTTP, auth, SSE, UI, Search, Streams consumer, worker unassign, deploy.
- `sh_assign_task` độc lập (membership của assignee đã kiểm tra qua create).
- Label, sprint, backlog: spike không ghi `label-tasks`, `sprint-tasks`, `backlog`, nên
  invariant 10 và 12 không được kiểm chứng ở đây.
- Hiệu năng ở quy mô lớn (chỉ đo ở quy mô demo: vài nghìn task).
- Mô phỏng mất điện cả máy (chỉ `kill -9` process).

## Decisions

- **Một node, không Cluster** (ADR-003). Dù vậy mỗi Function vẫn khai báo đủ `KEYS`
  mà nó đọc/ghi, vì Redis yêu cầu và để giữ đường lên Cluster.
- **Key biết trước khi gọi** (ADR-016):
  - Issue key nằm trong HASH `workspace-task-keys:{wsId}` (`"SHAPI-12" → taskId`,
    `HSETNX`), không dùng key `task-key:{ws}:{KEY-n}` chỉ biết sau `INCR`.
  - Vị trí chỉ nằm trong ZSET `board:{p}:{status}`; JSON task không có `position`.
    Rebalance chỉ ghi một ZSET. Task neo đọc bằng `ZSCORE` trên board đích.
  - `taskId` do caller sinh (ULID) và truyền vào; Function từ chối nếu đã tồn tại.
- **Chữ ký Function** (tất cả key có prefix `sh:v1:`; mọi Function trước hết dựng lại
  tên key từ ARGS và so với KEYS, lệch thì `KEYS_MISMATCH`):

  | Function | KEYS | ARGS |
  | --- | --- | --- |
  | `sh_create_task` | `workspace-members:{ws}`, `project:{p}`, `project-task-seq:{p}`, `workspace-task-keys:{ws}`, `task:{t}`, `project-tasks:{p}`, `board:{p}:TODO`, `user-assigned:{u}` (không gán: `user-assigned:none`, Function không đọc/ghi slot này), `workspace-seq:{ws}`, `workspace-changes:{ws}`, `stream:domain-events`, `idempotency:{actor}:{key}` | wsId, projectId, actorId, taskId, assigneeId hoặc rỗng, payload JSON, requestHash, clientMutationId, nowMs |
  | `sh_move_task` | `workspace-members:{ws}`, `project:{p}`, `task:{t}`, `board:{p}:{from}`, `board:{p}:{to}`, `workspace-seq:{ws}`, `workspace-changes:{ws}`, `stream:domain-events`, `idempotency:{actor}:{key}` | wsId, projectId, taskId, actorId, from, to, afterTaskId, beforeTaskId, expectedVersion, requestHash, clientMutationId, nowMs |
  | `sh_remove_member` | `workspace-members:{ws}`, `user-workspaces:{u}`, `workspace-seq:{ws}`, `workspace-changes:{ws}`, `stream:domain-events` | wsId, actorId, userId, nowMs |

- **Thứ tự kiểm tra** (quy ước chung v1.5): KEYS khớp ARGS → đọc project/task thật,
  đối chiếu workspace/project (và `task.status == from` với move) → quyền actor trên
  workspace thật → tra idempotency, có thì replay → điều kiện nghiệp vụ → ghi → lưu
  idempotency. Caller nhận `KEYS_MISMATCH` thì đọc lại và gọi lại (tối đa 2 lần).
- **Idempotency:** STRING chứa JSON `{requestHash, response}`, key theo actor, TTL 24h.
  `requestHash` = sha256(tên thao tác + đích + payload client gửi đã chuẩn hóa), không
  gồm `from` hay `nowMs`. Đây là cơ chế retry duy nhất: bỏ fallback
  `lastClientMutationId` (ULID của tab không chứng minh được ai gửi).
- **Issue number:** đọc `n = project-task-seq + 1`, kiểm `HEXISTS` đúng field
  `{KEY}-{n}` trước khi ghi, rồi `INCR` (bằng `n` vì Function chạy tuần tự) và `HSETNX`
  cùng field đó.
- **Task neo:** sau khi loại task đang move, `afterTaskId`/`beforeTaskId` phải khác
  nhau, có trong board đích và kề nhau; chỉ `after` thì là task cuối, chỉ `before` thì
  là task đầu, không có thì chèn cuối; cột rỗng score 1024. Mọi score mới (kể cả create
  ở cuối cột) phải nằm trong `|2^50|`, không thì rebalance.
- **Reply:** chuỗi JSON `{"ok":true,"data":…,"seq":…}` hoặc
  `{"ok":false,"code":…,"params":…}`; lỗi giao thức Redis chỉ dành cho bug (reply lỗi
  của Lua chỉ mang được một chuỗi, mất `params`). Mã: `KEYS_MISMATCH` (nội bộ),
  `NOT_FOUND`, `PROJECT_ARCHIVED`, `ASSIGNEE_NOT_MEMBER`, `IDEMPOTENCY_KEY_REUSED`,
  `TASK_VERSION_CONFLICT` (`params.currentVersion`), `INVALID_STATUS_TRANSITION`,
  `INVALID_POSITION_ANCHOR`, `BOARD_REBALANCE_REQUIRED`.
- **Event:** mỗi mutation được chấp nhận phát đúng một event (`TASK_CREATED`,
  `TASK_MOVED` có `rebalancedColumn` khi có rebalance, `MEMBER_REMOVED`) với một seq;
  rebalance ghi thêm entry `board:{p}:{status}` vào `workspace-changes` cùng seq.
- **Outbox tối thiểu trong spike:** create và move đều `INCR workspace-seq`,
  `ZADD workspace-changes`, `XADD stream:domain-events`; không có consumer.
- **Verifier:** script TypeScript chạy offline khi không có ghi, được phép `SCAN`
  (ngoài request path). Quét hai chiều: từ `task:*` sang index và từ index về JSON;
  kiểm score là số nguyên trong `|2^50|`. Verifier chỉ cam kết tính nhất quán của index
  (invariant 4, 5, 9); event và idempotency được kiểm bằng assertion riêng trong kịch bản.
- **Kịch bản:** TypeScript chạy bằng `tsx` với node-redis; mỗi kịch bản một file
  trong `spikes/redis-core/scenarios/`, dùng dữ liệu riêng (workspace riêng), in kết
  quả dạng bảng và thoát mã khác 0 khi fail. Kịch bản song song dùng các kết nối riêng
  cho từng luồng, để auto-pipelining của node-redis không cố định thứ tự gửi.
- **Dữ liệu:** seed 1 workspace, 1 project `SHAPI`, 3 member, tối đa 5.000 task để đo
  bộ nhớ.
- **Đo latency:** phía server dùng `SLOWLOG` với `slowlog-log-slower-than 0` và
  `slowlog-max-len` đủ lớn trong lượt đo cô lập (mặc định chỉ ghi lệnh ≥ 10 ms); phía
  client đo quanh `FCALL` qua loopback, chỉ dùng để so hai mode fsync. Ghi rõ máy đo.
  Lưu ý `busy-reply-threshold` mặc định 5 giây và Redis không tự dừng Function.
- **fsync:** cùng workload ghi với `everysec` rồi `always`; client ghi log ID đã gửi và
  ID đã nhận ACK, sau `kill -9` khởi động lại trên cùng volume và đối chiếu. Mỗi lần gọi
  Function vào AOF thành một khối `MULTI`/`EXEC` (kể cả phần ghi trước lỗi Lua);
  `aof-load-truncated yes` bỏ khối cụt ở đuôi. Kỳ vọng nhất quán chỉ áp cho mutation
  hợp lệ; request đang bay lúc kill được thống kê riêng.

## Risks / Trade-offs

- Lua lỗi giữa chừng không rollback → mỗi Function đọc và kiểm tra hết trước lệnh ghi
  đầu tiên; lỗi sau khi ghi chỉ có thể là bug và được kiểm tra bằng kịch bản tiêm lỗi.
- Thứ tự chỉ nằm trong ZSET → mất ZSET thì mất thứ tự; chấp nhận vì AOF + backup giữ
  ZSET như mọi key khác. Sửa cục bộ giữ score còn hợp lệ; mất hẳn ZSET thì dựng lại
  theo `(createdAtMs, taskId)`, thứ tự kéo thả cũ chỉ lấy lại được từ backup.
- `kill -9` không giống mất điện: page cache của host vẫn còn, nên 0 bản ghi mất với
  `everysec` trong phép thử chưa chứng minh RPO = 0. `everysec` mất khoảng 1 s trong
  điều kiện bình thường, fsync chậm có thể kéo dài hơn.
- Đo trên laptop khác VM Oracle arm64 → số đo chỉ để so sánh tương đối; đo lại trên
  VM khi deploy lần đầu.
- Rebalance tốn hơn dự kiến → giới hạn cột ≤ 500 trong một Function; lớn hơn trả
  `BOARD_REBALANCE_REQUIRED`, job batch thuộc change board.
