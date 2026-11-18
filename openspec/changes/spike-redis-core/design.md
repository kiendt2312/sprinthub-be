## Context

Thiết kế v1.3 (`docs/design/design.md`) đặt mọi thao tác ghi nhiều key vào Redis
Functions và mọi điều kiện invariant vào trong Function (ADR-009, ADR-010). Chưa có
dòng code nào chứng minh điều này chạy đúng và đủ nhanh trên Redis 8. Spike làm việc
đó với phạm vi nhỏ nhất: workspace, project, task, board của một project.

## Goals / Non-Goals

**Goals:**
- `sh_create_task` cấp issue key không trùng khi 50 request chạy song song.
- `sh_move_task` cho đúng 1 thành công, 1 `VERSION_CONFLICT` khi 2 client move cùng
  version; task luôn nằm đúng 1 cột (invariant 4, 5).
- Retry cùng `Idempotency-Key` không tạo task thứ hai; cùng key khác payload bị từ
  chối (invariant 17).
- Assign/create với assignee không còn là member bị Function từ chối, kể cả khi
  "remove member" chạy chen giữa (invariant 3).
- Rebalance giữ nguyên thứ tự, không tăng `version`.
- Dữ liệu còn nguyên sau `docker restart`; đo dữ liệu mất sau `kill -9` với
  `everysec` và `always`.
- Số đo: p50/p99 latency mỗi Function, `MEMORY USAGE` của một task JSON và các index.

**Non-Goals:**
- NestJS, HTTP, auth, SSE, UI, Search, Streams consumer, deploy.
- Hiệu năng ở quy mô lớn (chỉ đo ở quy mô demo: vài nghìn task).

## Decisions

- **Ngôn ngữ Function:** Lua trong Redis Functions (`#!lua name=sprinthub`), load bằng
  `FUNCTION LOAD REPLACE`. Mỗi Function khai báo đủ `KEYS`.
- **Kịch bản:** TypeScript chạy bằng `tsx` với node-redis; mỗi kịch bản là một file
  trong `spikes/redis-core/scenarios/`, in kết quả dạng bảng.
- **Dữ liệu:** seed 1 workspace, 1 project `SHAPI`, 3 member, tối đa 5.000 task để đo
  bộ nhớ.
- **Đo latency:** đo phía client quanh `FCALL` (loopback) và đối chiếu `SLOWLOG`;
  ghi rõ máy đo.
- **fsync:** chạy cùng kịch bản ghi với `appendfsync everysec` rồi `always`, so p99 và
  số bản ghi mất sau `kill -9`.

## Risks / Trade-offs

- Lua lỗi giữa chừng không rollback → mỗi Function đọc và kiểm tra hết trước lệnh
  ghi đầu tiên; có kịch bản cố tình gây lỗi để kiểm tra.
- Đo trên laptop khác VM Oracle arm64 → số đo chỉ để so sánh tương đối; đo lại trên
  VM khi deploy lần đầu.
- Spike có thể tốn hơn dự kiến nếu rebalance phức tạp → giới hạn rebalance trong 1
  Function cho cột ≤ 500 task, phần còn lại ghi thành việc của change board.
