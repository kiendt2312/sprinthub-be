# Architecture Decision Records

Chi tiết lý do của từng ADR nằm trong mục "Testing và ADR" của
[../design/design.md](../design/design.md). File ADR riêng sẽ được tách ra khi một
quyết định cần thảo luận dài hơn.

| ADR | Quyết định | Trạng thái |
| --- | --- | --- |
| 001 | Redis 8 là database duy nhất | Chấp nhận |
| 002 | JSON gốc + index SET/ZSET dựng lại được | Chấp nhận |
| 003 | Một Redis node trước Cluster | Chấp nhận |
| 004 | Streams cho event bền, Pub/Sub chỉ là tín hiệu | Chấp nhận |
| 005 | Thứ tự task bằng số nguyên cách quãng 1024 | Chấp nhận |
| 006 | Key gốc không có sub-key | Chấp nhận |
| 007 | Platform Admin tách khỏi tenant, không đọc nội dung | Chấp nhận (v1.4: chạy ở repo admin riêng) |
| 008 | Một domain-event stream + `workspace-seq` | Chấp nhận |
| 009 | Mọi điều kiện invariant nằm trong Function | Chấp nhận |
| 010 | Idempotency trong Function, `FCALL` không retry mù | Chấp nhận |
| 011 | Luồng local → prod, $0, Oracle Free, không K8s/Argo | Chấp nhận |
| 012 | Realtime bằng SSE, `Last-Event-ID` = `seq` | Chấp nhận |
| 013 | Nhiều repo, `sprinthub-be` làm trung tâm; contract OpenSpec + OpenAPI | Chấp nhận |
| 014 | Song ngữ EN/VI, BE trả `code` + `params` | Chấp nhận |
| 015 | Platform Admin tách 2 repo; admin-service ghi chỉ qua Function của BE | Chấp nhận |
| 016 | Thứ tự chỉ nằm trong ZSET board/backlog; issue key qua HASH `workspace-task-keys` | Chấp nhận |
