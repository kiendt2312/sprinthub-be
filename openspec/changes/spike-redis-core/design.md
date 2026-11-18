## Context

Thiết kế v1.5 (`docs/design/design.md`) đặt mọi thao tác ghi nhiều key vào Redis
Functions và mọi điều kiện invariant vào trong Function (ADR-009, ADR-010). Chưa có
dòng code nào chứng minh điều này chạy đúng và đủ nhanh trên Redis 8. Spike làm việc
đó với phạm vi nhỏ nhất: workspace, project, task, board của một project.

## Goals / Non-Goals

**Goals:**
- `sh_create_task` cấp issue key không trùng khi 50 request chạy song song.
- `sh_move_task` cho đúng 1 thành công, 1 `TASK_VERSION_CONFLICT` khi 2 client move
  cùng version; task luôn nằm đúng 1 cột (invariant 4, 5).
- Retry cùng `Idempotency-Key` không tạo task thứ hai, không tăng seq hay phát event
  lần hai; cùng key khác payload bị từ chối (invariant 8, 13, 17).
- Membership được Function kiểm tra tại thời điểm ghi, theo cả hai thứ tự create/remove
  (invariant 3).
- Mọi nhánh từ chối không ghi gì; lỗi sau khi đã ghi bị verifier phát hiện.
- Rebalance giữ nguyên thứ tự, không đổi `version` của task nào.
- Dữ liệu và library còn nguyên sau `docker restart`; đo số ghi đã ACK bị mất sau
  `kill -9` với `everysec` và `always`.
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
- **Chữ ký Function** (tất cả key có prefix `sh:v1:`):

  | Function | KEYS | ARGS |
  | --- | --- | --- |
  | `sh_create_task` | `workspace-members:{ws}`, `project:{p}`, `project-task-seq:{p}`, `workspace-task-keys:{ws}`, `task:{t}`, `project-tasks:{p}`, `board:{p}:TODO`, `user-assigned:{u}` (không gán thì truyền `user-assigned:none`, Function không chạm tới), `workspace-seq:{ws}`, `workspace-changes:{ws}`, `stream:domain-events`, `idempotency:{actor}:{key}` | actorId, taskId, payload JSON, requestHash, clientMutationId, nowMs |
  | `sh_move_task` | `workspace-members:{ws}`, `project:{p}`, `task:{t}`, `board:{p}:{from}`, `board:{p}:{to}`, `workspace-seq:{ws}`, `workspace-changes:{ws}`, `stream:domain-events`, `idempotency:{actor}:{key}` | actorId, toStatus, beforeTaskId, afterTaskId, expectedVersion, clientMutationId, requestHash, nowMs |
  | `sh_remove_member` | `workspace-members:{ws}`, `user-workspaces:{u}`, `workspace-seq:{ws}`, `stream:domain-events` | actorId, userId, nowMs |

  `from` do caller đọc từ task trước khi gọi; Function kiểm tra lại `task.status ==
  from`, sai thì trả `TASK_VERSION_CONFLICT` để caller đọc lại và gọi lại.
- **Idempotency:** STRING chứa JSON `{requestHash, response}`, key theo actor, TTL 24h.
  `requestHash` = sha256(tên thao tác + đích + payload chuẩn hóa). Thứ tự: kiểm tra
  membership → tra idempotency → kiểm tra nghiệp vụ → ghi → lưu idempotency ở cuối.
- **Mã lỗi** theo v1.5: `NOT_FOUND`, `PROJECT_ARCHIVED`, `ASSIGNEE_NOT_MEMBER`,
  `IDEMPOTENCY_KEY_REUSED`, `TASK_VERSION_CONFLICT` (kèm `currentVersion`),
  `INVALID_STATUS_TRANSITION`, `INVALID_POSITION_ANCHOR`, `BOARD_REBALANCE_REQUIRED`.
  Function trả lỗi dạng `{err: code, params}` để caller map.
- **Outbox tối thiểu trong spike:** create và move đều `INCR workspace-seq`,
  `ZADD workspace-changes`, `XADD stream:domain-events`; không có consumer.
- **Verifier:** script TypeScript chạy offline khi không có ghi, được phép `SCAN`
  (ngoài request path). Quét hai chiều: từ `task:*` sang index và từ index về JSON.
- **Kịch bản:** TypeScript chạy bằng `tsx` với node-redis; mỗi kịch bản một file
  trong `spikes/redis-core/scenarios/`, dùng dữ liệu riêng (workspace riêng), in kết
  quả dạng bảng và thoát mã khác 0 khi fail.
- **Dữ liệu:** seed 1 workspace, 1 project `SHAPI`, 3 member, tối đa 5.000 task để đo
  bộ nhớ.
- **Đo latency:** phía server dùng `SLOWLOG` với `slowlog-log-slower-than 0` và
  `slowlog-max-len` đủ lớn trong lượt đo cô lập (mặc định chỉ ghi lệnh ≥ 10 ms); phía
  client đo quanh `FCALL` qua loopback, chỉ dùng để so hai mode fsync. Ghi rõ máy đo.
  Lưu ý `busy-reply-threshold` mặc định 5 giây và Redis không tự dừng Function.
- **fsync:** cùng workload ghi với `everysec` rồi `always`; client ghi log ID đã nhận
  ACK, sau `kill -9` khởi động lại trên cùng volume và đối chiếu.

## Risks / Trade-offs

- Lua lỗi giữa chừng không rollback → mỗi Function đọc và kiểm tra hết trước lệnh ghi
  đầu tiên; lỗi sau khi ghi chỉ có thể là bug và được kiểm tra bằng kịch bản tiêm lỗi.
- Thứ tự chỉ nằm trong ZSET → mất ZSET thì mất thứ tự; chấp nhận vì AOF + backup giữ
  ZSET như mọi key khác, verifier dựng lại theo `createdAtMs`.
- `kill -9` không giống mất điện: page cache của host vẫn còn, nên 0 bản ghi mất với
  `everysec` trong phép thử chưa chứng minh RPO = 0.
- Đo trên laptop khác VM Oracle arm64 → số đo chỉ để so sánh tương đối; đo lại trên
  VM khi deploy lần đầu.
- Rebalance tốn hơn dự kiến → giới hạn cột ≤ 500 trong một Function; lớn hơn trả
  `BOARD_REBALANCE_REQUIRED`, job batch thuộc change board.
