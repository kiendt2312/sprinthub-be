# Thiết kế workspace và membership P0

## Context

Bám Keyspace, RBAC và Worker của design v1.7. Redis JSON lưu workspace,
HASH lưu membership và SET `user-workspaces:{uid}` là reverse index.
Thêm hai ZSET phân trang với score 0, theo ID tăng dần để có cursor
`(0,id)` và giới hạn mỗi lần đọc. Không cần đọc toàn bộ HASH hoặc SET.
Ghi cả index phân trang và index gốc trong một Function. Dữ liệu workspace
và membership mới đều đi qua v4. Fixture kiểu spike có thể tiếp tục gọi
chữ ký cũ độc lập với API workspace.

## Decisions

### API và Redis Functions workspace

Controller dùng session và CSRF guard hiện có, DTO allow-list, shared
write quota rồi Repository gọi Function. Đọc list lấy ứng viên bằng
`ZRANGE BYLEX` và đọc lại workspace/canonical membership ở batch sau.
Đọc chi tiết và list thành viên kiểm membership trong cùng thao tác đọc
với dữ liệu trả về (transaction chỉ đọc hoặc FCALL_RO). Không có quyền
Platform Admin kế thừa trong API này. Prefix cấu hình đi qua key builder.

Trong bảng, các key bỏ prefix. `W = workspace-members:{w}, workspace:{w}`.
`R(u) = user-workspaces:{u}, user-workspaces-page:{u}, workspace-members-page:{w}`.
`O = workspace-seq:{w}, workspace-changes:{w}, stream:domain-events,
idempotency:{actor}:{idem}`. `M = idem, hash, nowMs, requestId, clientMutationId`.
Chuỗi rỗng là giá trị vắng mặt. Bảng ghi đúng thứ tự KEYS và ARGS.

| Function | KEYS | ARGS |
| --- | --- | --- |
| `sh_create_workspace` | W, R(actor), workspace-slug:{slug}, workspaces-by-created, user:{actor}, O | w, actor, name, slug, M |
| `sh_update_workspace` | W, workspace-slug:{old}, workspace-slug:{new}, O | w, actor, old, new, expectedVersion, name?, slug?, M |
| `sh_add_workspace_member` | W, R(u), user:{u}, user-email:{digest} hoặc user-email:none, O | w, actor, u?, digest?, M |
| `sh_update_workspace_role` | W, O | w, actor, u, role, expectedVersion, M |
| `sh_transfer_workspace_owner` | W, O | w, actor, u, M |
| `sh_remove_workspace_member` | W, R(u), stream:audit, O | w, actor, u, mode (remove/leave), M |

Với email chưa resolve, dùng R(none) và user:none, giữ digest để Function
tự kiểm tra lại. Thứ tự kiểm tra là độ dài/đối chiếu KEYS từ ARGS → workspace
thật và membership → quyền → idempotency → validation domain, version, unique,
target, preflight kiểu key/counter, chuẩn bị JSON/reply → ghi → lưu replay 24 h.
Mutation mới trên workspace có `suspendedAt` trả `WORKSPACE_SUSPENDED`
sau bước replay. Lần gọi lại hợp lệ trả kết quả đã lưu.
Create kiểm user đăng ký còn active trước replay. Hash chỉ dùng dữ liệu
request nên có thể replay khi API sinh ID mới. Update đối chiếu slug cũ với workspace thật trước khi ghi và dùng
`withKeySnapshot` để đọc lại, tối đa hai lần. Add bằng email đối chiếu lại
email index với user ID đã đọc. Index vừa xuất hiện hoặc trỏ sang ID khác
thì trả `KEYS_MISMATCH`. Chuỗi email tiêu chuẩn hóa dùng cùng
helper auth. Hash dựa trên selector do client gửi.

Owner truyền quyền cập nhật đồng thời `ownerId` và hai field HASH. Chỉ thao
tác transfer cho phép kiểm replay sau membership nhưng trước yêu cầu OWNER,
vì transfer tự hạ quyền actor xuống ADMIN. Các role ghi nhận chỉ có ba giá
trị trong contract. Các đường khởi tạo và thay đổi role/owner giữ đúng một
Owner theo quy nạp. Remove và leave dùng chung Function, phát
`MEMBER_REMOVED`, ghi audit và xóa cả reverse index lẫn index trang. Giữ
nguyên `sh_remove_member` v3 và các chữ ký của spike. Không dùng lại hàm
cũ cho route HTTP vì điểm vào cũ không có workspace JSON, audit và index trang
trong KEYS. Audit P0 của change chỉ ghi cho remove và leave. Mọi thay đổi có hiệu lực
tăng workspace version/seq và ghi change cùng event.
Event workspace/member kèm `entityVersion`, `clientMutationId`, `requestId`.

### Worker và việc dọn assignee

Bootstrap `XGROUP CREATE ... unassign 0-0 MKSTREAM`, bỏ qua BUSYGROUP.
Dùng 0-0 để không mất event phát khi API và worker khởi động song song.
Bỏ qua và ACK ngay event loại khác. Worker có kết nối blocking riêng với
BLOCK hữu hạn, tiếp tục reconnect, định kỳ XAUTOCLAIM và XPENDING để biết
số lượt giao. Nếu lần xử lý thứ tư vẫn lỗi dữ liệu, đưa vào DLQ. Lỗi kết nối
hoặc kết quả ghi chưa rõ giữ pending để reclaim. Function DLQ ghi entry
nguồn cùng marker dedupe từ Redis stream ID rồi mới ACK. Log chỉ ghi ID.

`eventId` của library hiện tại là `{w}:{seq}`. Job ID
`unassign-{w}-{seq}` suy ra từ eventId, không chứa dấu hai chấm.
Function persist dùng `JSON.SET job:{id} $ ... NX` và đăng lịch ZSET
`unassign-jobs-by-due` trước ACK. Worker dùng `ZRANGE BYSCORE` có giới hạn
để lấy job đến hạn sau bootstrap/reconnect, theo ACL cấm SCAN. Claim/batch
cập nhật lịch theo lease và xóa lịch khi job terminal. Cảnh báo job kẹt
quá 15 phút. Duyệt `user-assigned:{u}` bằng SSCAN và chia mỗi trang theo
`UNASSIGN_BATCH_SIZE` vì COUNT chỉ là gợi ý. Worker mặc định dùng 50 task và nhận
giá trị cấu hình từ 1 đến 100. Function chặn batch vượt 100. Mặc định 50 giữ
thêm biên cho ngân sách 5 ms sau khi batch 100 task vượt ngưỡng trong lượt
integration lặp trên máy đang tải. [Redis SSCAN](https://redis.io/docs/latest/commands/sscan/).
Cursor tiến sau khi xử lý cả trang. Khi chạy lại trang sau crash, Function
kiểm assignee hiện tại trước khi ghi. Không đặt TTL job pending/running.
Giữ job terminal và marker DLQ để một event pending lâu vẫn dedupe.

| Function | KEYS | ARGS |
| --- | --- | --- |
| `sh_persist_unassign_job` | job:{id}, unassign-jobs-by-due | id, w, u, eventId |
| `sh_claim_unassign_job` | job:{id}, unassign-jobs-by-due, lock:unassign:{w}:{u}, fence:unassign:{w}:{u} | id, w, u, token |
| `sh_run_unassign_batch` | job:{id}, unassign-jobs-by-due, lock:unassign:{w}:{u}, fence:unassign:{w}:{u}, workspace-members:{w}, user-assigned:{u}, workspace-seq:{w}, workspace-changes:{w}, stream:domain-events, task:{t}... | id, w, u, token, epoch, cursor, nextCursor (rỗng khi chưa hết trang), task ID... |
| `sh_dead_letter_unassign` | stream:domain-events, stream:dead-letter, processed:dlq:{streamId} | streamId |

Job có `id,workspaceId,userId,eventId,createdAtMs,cursor,status` (PENDING/RUNNING/DONE).
Token là UUID của lần chạy. Lease 30 giây, chỉ claim nếu lock trống, cấp
epoch tăng dần và trả `{epoch,cursor}`. Job chưa claim được trả `data:null`.
Batch thành công trả `{done,cursor}`. Batch kiểm key/tenant thật, lock token + epoch mới nhất
và cursor còn trùng trước bất kỳ lệnh ghi nào (lần lượt `STALE_JOB_EPOCH`
và `STALE_JOB_CURSOR`). Khi job khác đang giữ lock, claim dời lịch tới
hạn lease hiện tại. Nếu membership đã trở lại,
đánh dấu DONE và nhả lock. Nếu vẫn vắng mặt, cập nhật task active đúng
tenant và assignee, srem index, tăng version, seq và lastSeq từng task,
ghi change và `TASK_UNASSIGNED`. Bỏ qua task thuộc tenant khác hoặc có
assignee khác. Task trong project archived vẫn được dọn. Preflight cả batch
trước ghi.
Batch thành công renew lease hoặc nhả lock khi kết thúc. Khi timeout worker
chờ lease mới rồi đọc trạng thái bền trước khi chạy tiếp.

`XTRIM ... MINID ~ <now-7d>-0 ACKED` định kỳ chỉ ở stream domain sau
bootstrap. ACL cấp key/command cần theo role và cấm app/worker trim audit.
[Redis XTRIM](https://redis.io/docs/latest/commands/xtrim/).

## Risks / Trade-offs

Mỗi request phân trang đọc trạng thái hiện hành. PEL giữ event pending.
Marker dedupe và job terminal giữ lại qua thời gian trim để khôi phục.
Verifier offline kiểm owner, slug, created, membership hai chiều và index trang.
SLOWLOG ngưỡng 0 đo Function trên Redis 8.10.3 với batch mặc định 50 task
và ngân sách 5 ms. Bốn lượt integration trên cùng volume ghi nhận tối đa
1,969 ms. Redis giữ các lệnh đã chạy khi Function gặp lỗi, nên Function
kiểm chỉ mục, kiểu key và dữ liệu của cả batch trước khi ghi.
