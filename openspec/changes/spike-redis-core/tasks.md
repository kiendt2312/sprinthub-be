## 1. Môi trường spike

- [x] 1.1 `spikes/redis-core/compose.yaml`: Redis 8.x có volume, `redis.conf` (AOF bật, `noeviction`, `maxmemory` nhỏ; comment luôn ở dòng riêng)
- [x] 1.2 Chọn bản Redis 8.x ổn định mới nhất, pin image digest trong `compose.yaml` **trước** mọi phép thử và ghi vào `REPORT.md`
- [x] 1.3 `package.json` tối thiểu (node-redis, tsx, typescript), key builder có prefix `sh:v1:`, helper decode reply JSON của Function, script `seed`
- [x] 1.4 Kiểm tra trên Redis thật: `docker compose up`, `PING`, `CONFIG GET appendonly appendfsync aof-timestamp-enabled aof-load-truncated maxmemory-policy` đúng giá trị, `JSON.SET`/`JSON.GET` round trip, `FUNCTION LIST` chạy được

## 2. Library Functions `sprinthub` (bản spike) và verifier

- [ ] 2.1 Helper Lua dùng chung: dựng key từ ARGS (gồm `idempotency:{actorId}:{idempotencyKey}`) và so với KEYS (`KEYS_MISMATCH`), reply JSON `{ok, code, params}`, tra/lưu idempotency, kiểm giới hạn cột 500 (`COLUMN_FULL`)
- [ ] 2.2 `sh_create_task` theo chữ ký và thứ tự kiểm tra trong `design.md`: KEYS → project thật → quyền → idempotency → archive/taskId/assignee/`n = seq + 1` và `HEXISTS` đúng field/biên score/giới hạn cột 500 → ghi `project-task-seq`, `workspace-task-keys`, JSON (không `position`), `project-tasks`, `board:{p}:TODO`, `user-assigned` (bỏ qua slot `none`), `workspace-seq`, `workspace-changes`, `XADD TASK_CREATED`, idempotency ở cuối (invariant 3, 4, 6, 8, 9, 13, 17)
- [ ] 2.3 `sh_move_task` theo chữ ký và thứ tự kiểm tra trong `design.md`: KEYS → task thật và `status == from` → quyền → idempotency → archive → `expectedVersion` → bảng chuyển trạng thái → quy tắc task neo → chèn cột rỗng/đầu/cuối/giữa; giới hạn cột 500 sau thao tác (`COLUMN_FULL`); rebalance trong cùng mutation, một event `TASK_MOVED` có `rebalancedColumn`, entry `board:{p}:{status}` cùng seq (invariant 4, 5, 8, 13, 17)
- [ ] 2.4 `sh_remove_member` tối giản: `HDEL workspace-members`, `SREM user-workspaces`, seq, `workspace-changes`, event `MEMBER_REMOVED` (invariant 3, 8, 13)
- [ ] 2.5 Verifier TypeScript `verify-task-indexes` chạy offline: `SCAN task:*` → index và index → JSON; báo missing/orphan/duplicate/wrong-pointer/bad-score cho `project-tasks`, board ZSET, `workspace-task-keys` (invariant 4, 5, 9)
- [ ] 2.6 Kiểm tra trên Redis thật: `FUNCTION LOAD REPLACE`, gọi từng Function với dữ liệu seed cho mỗi mã lỗi và decode được `params`, verifier báo sạch

## 3. Kịch bản chứng minh

Mỗi kịch bản dùng workspace riêng, snapshot trước/sau cho các nhánh từ chối; kịch bản
song song dùng kết nối riêng cho từng luồng.

- [ ] 3.1 50 `sh_create_task` song song → 50 issue number khác nhau, seq = 50, verify sạch; field kế tiếp đã bị chiếm khi `workspace-seq` ≠ `project-task-seq` → từ chối trước khi ghi (invariant 9)
- [ ] 3.2 2 move cùng version, khác `clientMutationId` và key → 1 thành công, 1 `TASK_VERSION_CONFLICT` có `params.currentVersion`, task ở đúng 1 cột (invariant 4, 8)
- [ ] 3.3 Idempotency: retry create cùng key; bỏ response của move khác cột rồi gửi lại nguyên lệnh; cùng key khác payload; actor bị xóa rồi retry; create thành công, archive project rồi retry cùng key (trả response đã lưu) → 1 task, 1 lần tăng version/seq, 1 event, đúng mã lỗi (invariant 8, 13, 17)
- [ ] 3.4 Tenant: bộ key của workspace khác cùng key idempotency đã dùng; KEYS chứa key idempotency của actor khác; `from` cũ chưa có idempotency → `KEYS_MISMATCH`/`NOT_FOUND`, không replay, không ghi (invariant 2)
- [ ] 3.5 Membership: remove trước rồi create; create trước rồi remove; không gán/có gán (`user-assigned:none` không tồn tại); 100 cặp xen kẽ trên 100 workspace với assertion đủ hai nhánh (invariant 3, 6)
- [ ] 3.6 Các nhánh từ chối của move: actor ngoài workspace, task không còn, project archive, TODO → DONE, 6 kiểu task neo sai → đúng mã lỗi, snapshot không đổi; reorder cùng cột đúng thứ tự
- [ ] 3.7 Thứ tự và rebalance: chèn cột rỗng/cuối/đầu/giữa; fixture 1024/1025; chèn lặp ngay dưới task vừa chèn tới khi rebalance; rebalance cột 500 task; kiểm một event và entry cột cùng seq; cột 500 task: create hoặc move sang cột đó → `COLUMN_FULL`, reorder trong cột vẫn được; cột 499 task và 2 create tranh slot cuối → đúng 1 thành công (invariant 4, 5, 8)
- [ ] 3.8 Lỗi trước khi ghi (key sai kiểu) → snapshot không đổi
- [ ] 3.9 Lỗi tiêm sau `JSON.SET task` và sau khi ghi index nhưng trước `XADD`, trên workspace riêng → verifier và assertion event/idempotency phát hiện đúng như spec
- [ ] 3.10 Verifier: làm hỏng 6 kiểu (thiếu board, thiếu cả `project-tasks` và board, nằm hai cột, orphan, `workspace-task-keys` trỏ sai, score `1.5`) → báo đúng từng mục
- [ ] 3.11 Kiểm tra trên Redis thật: chạy lại toàn bộ 3.1–3.10 từ dữ liệu sạch; verify sạch sau mỗi kịch bản, trừ workspace cố tình hỏng của 3.9, 3.10 (ở đó so báo cáo với kỳ vọng)

## 4. Persistence và số đo

- [ ] 4.1 `docker restart` → `FUNCTION LIST` còn library, verify sạch, thứ tự cột, `workspace-seq`, idempotency còn hạn không đổi (invariant 4, 5, 13, 17)
- [ ] 4.2 `kill -9` khi đang tạo task, client ghi log `taskId` đã gửi và đã ACK, khởi động lại trên cùng volume; chạy với `always` rồi `everysec`; mỗi task còn lại có đủ JSON, index, event, idempotency; `always` không mất ID đã ACK, `everysec` báo số mất và số request đang bay; so p99 phía client (invariant 4, 8, 9, 17)
- [ ] 4.3 Đo phía server bằng `SLOWLOG` (`slowlog-log-slower-than 0`, `slowlog-max-len` lớn) max (ngân sách < 5 ms) và p50/p99 (quan sát) cho create, move thường và move có rebalance cột 500; đo `MEMORY USAGE` task JSON và index với 5.000 task (10 project × 500 task)
- [ ] 4.4 Viết `spikes/redis-core/REPORT.md`: máy đo, bản Redis + digest, bảng số đo, quyết định `appendfsync`, giới hạn cột rebalance, các giả định bị bác bỏ
- [ ] 4.5 Kiểm tra trên Redis thật: chạy lại 4.1–4.3 trên image đã pin; cập nhật `docs/design/design.md` và `openspec` nếu kết quả khác thiết kế; chốt 2 quyết định mở trong Spec
