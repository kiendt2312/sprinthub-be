## Context

P0 dùng contract `projects`, design v1.7 và hành vi đã kiểm chứng trong `redis-task-core`. API dùng v5, library giữ các chữ ký spike cũ.

## Goals / Non-Goals

Hoàn thành task mutation, permalink, list/filter, board P0 và kiểm tra tính bền. Sprint, label, comment, search, SSE và API backlog thuộc P1.

## Decisions

| Function (v5) | KEYS theo thứ tự, sau prefix | ARGS theo thứ tự |
| --- | --- | --- |
| `sh_create_task` | members, project, project-task-seq:pid, workspace-task-keys:wid, task, project-tasks:pid, board:pid:TODO, user-assigned:assignee, workspace:wid, backlog:pid, outbox | wid, pid, actor, tid, assignee (hoặc rỗng), payloadJson, idem, hash, clientMutationId, nowMs, requestId |
| `sh_move_task` | members, project, task, board:pid:from, board:pid:to, workspace:wid, outbox | wid, pid, tid, actor, from, to, afterId, beforeId (neo thiếu dùng rỗng), expectedVersion, idem, hash, clientMutationId, nowMs, requestId |
| `sh_update_task` / `sh_assign_task` | members, workspace, project, task, user-assigned:old, user-assigned:new, outbox | wid, pid, tid, actor, oldAssignee, newAssignee, expectedVersion, patchJson, meta |
| `sh_delete_task` | members, workspace, project, task, project-tasks:pid, board:pid:status, backlog:pid, user-assigned:old, outbox | wid, pid, tid, actor, status, oldAssignee, expectedVersion, meta |

`members` là `workspace-members:wid`, workspace/project/task là JSON gốc. `outbox` và `meta` theo projects. Assignee thiếu dùng ARGS rỗng và slot `user-assigned:none` không bị ghi. Patch của update có title, description, priority, dueAtMs và assigneeId tùy chọn (null để bỏ due/assignee); newAssignee phải khớp patch hoặc oldAssignee nếu field vắng. Patch của assign chứa đúng assigneeId. Cùng tên Function dispatch theo arity. Create giữ 12 key/10–11 args cho v4 và nhận 14 key/11 args cho v5. Move giữ 9 key/13–14 args cho v4 và nhận 10 key/14 args cho v5. Thứ tự, field response và semantics của chữ ký cũ theo spike. Loại arity khác trả KEYS_MISMATCH. LIB_VERSION tăng 4 → 5, API, worker và loader kiểm v5. Khi triển khai, nạp library BE trước, rồi restart process kiểm version, gồm admin-service khi có. Delete chỉ xử lý task P0 không có sprint/label.

1. Kiểm KEYS, đọc entity thật, đối chiếu tenant, actor role và state dùng để dựng key (from, oldAssignee, status). Caller mới kiểm workspace thật. Actor ngoài tenant nhận 404. Delete xác thực OWNER/ADMIN hoặc reporter hiện tại trước replay.
2. Tra idempotency. Hash chuẩn hóa gồm thao tác, đích, payload HTTP và mutation ID, loại các snapshot, ID server sinh và thời gian. Replay giữ data/seq. Task tombstone trả 404 khi đọc hoặc ghi mới. Actor còn quyền retry với cùng actor/key/hash của mutation đã thành công nhận data và seq cũ, kể cả khi bản ghi hiện là tombstone hoặc project hiện archived.
3. Kiểm archive và suspend, version và điều kiện riêng. Create kiểm assignee, ID, slot 500 và issue number. Update/assign kiểm member khi gửi assignee, kể cả assign lại cùng ID. Move giữ sơ đồ chuyển trạng thái, quy tắc neo, cap 500, rebalance và một event của spike. Delete gỡ project-tasks, board, backlog, reverse assignee. Permalink HASH giữ field để không tái sử dụng, nhưng GET tombstone trả 404.
4. Preflight kiểu key, counters và payload trước ghi. Giữ độ chính xác số nguyên Redis/Lua. Backlog create dùng issue number làm score tăng dần và kiểm biên 2^50. Move không đổi backlog. Update/assign/delete tăng version/seq, cập nhật lastSeq và phát một event `TASK_UPDATED`/`TASK_ASSIGNED`/`TASK_DELETED`. Lưu replay cuối. Create/move giữ dữ liệu và metadata của spike. Nhánh v5 thêm rebalancedColumn tùy chọn vào response lưu replay.
5. Contract HTTP quản lý retry. Chỉ retry nội bộ sau reply `KEYS_MISMATCH` xác định chưa ghi, tối đa hai lần với snapshot mới. Timeout/không rõ trả 503 không gọi lại. Fixture T-008 bỏ reply sau khi Redis thực thi, client gửi lại cùng header.

### Đọc

Board có đúng ba batch khi đọc project có dữ liệu. Guard pipeline HGETALL session + quota đã biết theo digest session. Touch chạy sau response. Batch 2 pipeline `JSON.GET project $.workspaceId` và bốn `ZRANGE`. Batch 3 pipeline `HGET workspace-members` của workspace thật và `JSON.GET` từng task với nhiều path gồm id/workspaceId/projectId/status/isDeleted/deletedAt/key/title/priority/assigneeId/dueAtMs/labelIds/version. Thêm id và cả hai marker xóa để loại bản ghi hỏng theo định danh hoặc tombstone dù marker còn lại bị lệch. Chỉ trả khi có membership. Kiểm kiểu mảng của từng path, bỏ task tenant lệch, đã xóa, dữ liệu thiếu hoặc đổi cột. Giới hạn 500 ID mỗi cột ngay ở lệnh đọc. Board không đọc description. Test T-021 đếm cả ba batch và loại dữ liệu lệch giữa batch.

List lọc status, assignee và priority. Đọc các ZSET cột (tối đa 2.000 candidate theo giới hạn cột), hợp thứ tự tăng theo (score, ID), bỏ tuple trước hoặc bằng cursor, lọc assignee/priority bằng projection trước khi đọc JSON đầy đủ, kiểm lại bộ lọc khi đọc dữ liệu và lấy các batch hữu hạn cho đến khi đủ `limit+1` match hoặc hết. Kiểm tenant/project/status/delete/membership khi đọc tài liệu, bỏ bản ghi stale. Cursor gắn actor, project, bộ lọc và tuple. Pagination cam kết đủ và duy nhất với fixture ổn định. Khi task move/reorder/rebalance thì client làm mới danh sách để lấy thứ tự mới. Request path không dùng SCAN/KEYS hoặc SMEMBERS trên SET không giới hạn.

Chi tiết task kiểm workspace thật và project thật, kể cả khi project archived. Permalink HGET rồi xác minh cả ID, workspace và key trên JSON. Verifier offline mở tùy chọn scope fixture, kiểm backlog và index active hai chiều, kiểm tombstone và permalink. Chế độ spike vẫn hỗ trợ fixture chữ ký cũ không có backlog.

## Risks / Trade-offs

List P0 dùng các ZSET đã giới hạn, đọc tiếp theo chunk nếu bộ lọc thưa. Khi cần query lớn hơn hoặc full text, P1 dùng Search. Biên nghiệm thu SLOWLOG mục tiêu 2,5 ms so với ngân sách Function 5 ms.

Khi nghiệm thu trên Redis 8.10.3, Function unassign với batch 50 task đã ghi nhận 2,965 ms. Mặc định giảm xuống 32 để giữ biên 2,5 ms. Khoảng cấu hình 1–100, chữ ký Function và ngữ nghĩa fencing/resume giữ như spec worker.

Phép đo bổ sung ghi nhận create/move vượt mốc 2,5 ms khi mô tả đạt 20.000 code point và khi cột đầy. Đường mutation task v5 chỉ đọc id, workspaceId, archivedAt và key của project bằng path đơn vị trí. Snapshot cũ thiếu marker archive được đọc qua JSONPath tùy chọn. Create dùng path đơn vị trí khi ghi JSON gốc. Move v5 cập nhật bốn field task qua path đơn vị trí. Rebalance chuyển score rank tối đa 512.000 trực tiếp sang Redis để tránh format chuỗi trong vòng lặp. Đường kiểm độ dài bỏ qua đếm UTF-8 khi số byte đã nằm trong giới hạn.
