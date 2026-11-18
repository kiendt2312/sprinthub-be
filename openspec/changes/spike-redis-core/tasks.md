## 1. Môi trường spike

- [ ] 1.1 `spikes/redis-core/compose.yaml`: Redis 8.x có volume, `redis.conf` (AOF bật, `noeviction`, `maxmemory` nhỏ; comment luôn ở dòng riêng)
- [ ] 1.2 Chọn bản Redis 8.x ổn định mới nhất, pin image digest trong `compose.yaml` và ghi vào `REPORT.md`
- [ ] 1.3 `package.json` tối thiểu (node-redis, tsx, typescript), key builder có prefix `sh:v1:` và script `seed`
- [ ] 1.4 Kiểm tra trên Redis thật: `docker compose up`, `PING`, `CONFIG GET appendonly appendfsync aof-timestamp-enabled maxmemory-policy` đúng giá trị, `JSON.SET`/`JSON.GET` round trip, `FUNCTION LIST` chạy được

## 2. Library Functions `sprinthub` (bản spike) và verifier

- [ ] 2.1 `sh_create_task` theo chữ ký trong `design.md`: membership actor trước, rồi idempotency (STRING, hash, TTL 24h), rồi project/taskId/assignee/field issue key; ghi `project-task-seq`, `workspace-task-keys`, JSON (không có `position`), `project-tasks`, `board:{p}:TODO`, `user-assigned`, `workspace-seq`, `workspace-changes`, `XADD`, idempotency ở cuối (invariant 3, 4, 8, 9, 13, 17)
- [ ] 2.2 `sh_move_task` theo chữ ký trong `design.md`: membership, task tồn tại/chưa xóa, project chưa archive, `status == from`, idempotency, `expectedVersion` hoặc `lastClientMutationId`, bảng chuyển trạng thái, task neo có score trong board đích; chèn đầu/cuối/giữa; rebalance cột ≤ 500 không đổi `version` task khác, phát `BOARD_REBALANCED`; cột > 500 trả `BOARD_REBALANCE_REQUIRED` trước khi ghi (invariant 4, 5, 8, 13, 17)
- [ ] 2.3 `sh_remove_member` tối giản: `HDEL workspace-members`, `SREM user-workspaces`, seq, event `MEMBER_REMOVED`
- [ ] 2.4 Verifier TypeScript `verify-task-indexes` chạy offline: `SCAN task:*` → index và index → JSON; báo missing/orphan/duplicate/wrong-pointer cho `project-tasks`, board ZSET, `workspace-task-keys`
- [ ] 2.5 Kiểm tra trên Redis thật: `FUNCTION LOAD REPLACE`, gọi từng Function với dữ liệu seed cho mỗi mã lỗi, verifier báo sạch

## 3. Kịch bản chứng minh

Mỗi kịch bản dùng workspace riêng, snapshot trước/sau cho các nhánh từ chối.

- [ ] 3.1 50 `sh_create_task` song song → 50 issue number khác nhau, seq = 50, verify sạch (invariant 9)
- [ ] 3.2 2 move cùng version, khác `clientMutationId` và key → 1 thành công, 1 `TASK_VERSION_CONFLICT` kèm `currentVersion`, task ở đúng 1 cột (invariant 4, 8)
- [ ] 3.3 Idempotency: retry cùng key; bỏ response rồi retry; cùng key khác payload; actor bị xóa rồi retry → 1 task, 1 lần tăng seq, 1 event, đúng mã lỗi (invariant 8, 13, 17)
- [ ] 3.4 Membership: remove trước rồi create (bị từ chối); create trước rồi remove (task giữ assignee, lần create sau bị từ chối); 100 cặp chạy xen kẽ trên 100 workspace, so `seq` của event (invariant 3)
- [ ] 3.5 Các nhánh từ chối của move: actor ngoài workspace, task không còn, project archive, TODO → DONE, task neo khác project/khác cột/không tồn tại → đúng mã lỗi, snapshot không đổi
- [ ] 3.6 Rebalance: fixture score 1024/1025 chèn giữa; chèn lặp tới khi rebalance; cột 501 task → `BOARD_REBALANCE_REQUIRED` (invariant 5)
- [ ] 3.7 Lỗi trước khi ghi (key sai kiểu, field issue key đã có) → snapshot không đổi
- [ ] 3.8 Lỗi tiêm sau `JSON.SET task` trên workspace riêng → verifier báo thiếu index, không có bản ghi idempotency
- [ ] 3.9 Verifier: làm hỏng 5 kiểu (thiếu board, thiếu cả `project-tasks` và board, nằm hai cột, orphan, `workspace-task-keys` trỏ sai) → báo đúng từng mục
- [ ] 3.10 Kiểm tra trên Redis thật: chạy lại 3.1–3.7 và 3.9 từ dữ liệu sạch, verify sạch sau mỗi kịch bản (trừ dữ liệu cố tình hỏng của 3.8, 3.9)

## 4. Persistence và số đo

- [ ] 4.1 `docker restart` → `FUNCTION LIST` còn library, verify sạch, thứ tự cột, `workspace-seq`, idempotency còn hạn không đổi
- [ ] 4.2 `kill -9` khi đang ghi, client ghi log `taskId` đã ACK, khởi động lại trên cùng volume; chạy với `always` rồi `everysec`; `always` không mất ID đã ACK, `everysec` báo số mất; verify sạch; so p99 phía client
- [ ] 4.3 Đo phía server bằng `SLOWLOG` (`slowlog-log-slower-than 0`, `slowlog-max-len` lớn) p50/p99/max cho create, move thường và move có rebalance cột 500; đo `MEMORY USAGE` task JSON và index với 5.000 task
- [ ] 4.4 Viết `spikes/redis-core/REPORT.md`: máy đo, bản Redis + digest, bảng số đo, quyết định `appendfsync`, giới hạn cột rebalance, các giả định bị bác bỏ
- [ ] 4.5 Kiểm tra trên Redis thật: chạy lại 4.1–4.3 trên image đã pin; cập nhật `docs/design/design.md` và `openspec` nếu kết quả khác thiết kế; chốt 2 quyết định mở trong Spec
