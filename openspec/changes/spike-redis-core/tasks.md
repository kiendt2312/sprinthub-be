## 1. Môi trường spike

- [ ] 1.1 `spikes/redis-core/compose.yaml`: Redis 8.x có volume, `redis.conf` (AOF bật, `noeviction`, `maxmemory` nhỏ)
- [ ] 1.2 Chọn bản Redis 8.x ổn định mới nhất, ghi image digest vào `REPORT.md`
- [ ] 1.3 `package.json` tối thiểu (node-redis, tsx, typescript) và script `seed`
- [ ] 1.4 Kiểm tra: `docker compose up`, `PING`, `FUNCTION LIST` chạy được

## 2. Library Functions `sprinthub` (bản spike)

- [ ] 2.1 `sh_create_task`: idempotency `SET NX` + `requestHash`, kiểm tra membership của actor và assignee trong Function, `INCR project-task-seq`, `task-key` NX, ghi JSON + `project-tasks` + `board:{p}:TODO` + `workspace-seq` (invariant 3, 4, 9, 17)
- [ ] 2.2 `sh_move_task`: bảng chuyển trạng thái, `expectedVersion`, `lastClientMutationId`, chèn trung điểm sparse integer, rebalance cột ≤ 500 không tăng `version` (invariant 4, 5, 8)
- [ ] 2.3 `sh_remove_member` tối giản để kiểm tra write skew
- [ ] 2.4 `sh_verify_task_indexes`: so JSON gốc với `project-tasks`, board ZSET, `task-key`; trả báo cáo missing/orphan/wrong-score
- [ ] 2.5 Kiểm tra: load library, gọi từng Function với dữ liệu seed

## 3. Kịch bản chứng minh

- [ ] 3.1 50 `sh_create_task` song song → 50 issue number khác nhau, verify sạch
- [ ] 3.2 2 move cùng version → 1 thành công, 1 `VERSION_CONFLICT`, task ở đúng 1 cột
- [ ] 3.3 Retry cùng `Idempotency-Key` → 1 task; cùng key khác payload → bị từ chối
- [ ] 3.4 Create với assignee trong lúc `sh_remove_member` chạy song song (lặp 100 lần) → không task nào giao cho non-member
- [ ] 3.5 Chèn liên tục vào cùng một chỗ tới khi phải rebalance → thứ tự đúng, `version` không đổi
- [ ] 3.6 Cố tình gây lỗi runtime giữa Function → ghi lại trạng thái còn lại, xác nhận Function kiểm tra trước khi ghi
- [ ] 3.7 Kiểm tra: chạy lại toàn bộ kịch bản 3.1–3.6, verify sạch sau mỗi kịch bản

## 4. Persistence và số đo

- [ ] 4.1 `docker restart` → dữ liệu và thứ tự cột còn nguyên, verify sạch
- [ ] 4.2 `kill -9` khi đang ghi với `everysec` rồi `always` → đếm bản ghi mất, so p99 ghi
- [ ] 4.3 Đo p50/p99 mỗi Function (client + `SLOWLOG`), đo `MEMORY USAGE` task JSON và index với 5.000 task
- [ ] 4.4 Viết `spikes/redis-core/REPORT.md`: máy đo, bản Redis + digest, bảng số đo, quyết định `appendfsync`, các giả định bị bác bỏ
- [ ] 4.5 Cập nhật `docs/design/design.md` và `openspec` nếu kết quả khác thiết kế; chốt 2 quyết định mở trong Spec
