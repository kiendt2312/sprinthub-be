## Why

Toàn bộ thiết kế SprintHub dựa trên giả định: Redis Functions giữ được dữ liệu đúng
khi nhiều người ghi cùng lúc, khi Redis restart và khi request bị retry. Trước khi
dựng NestJS, Next.js hay hạ tầng, cần chứng minh giả định đó bằng code chạy thật và
số đo. Spike cũng chốt hai quyết định còn mở: bản Redis 8.x (image digest) và
`appendfsync always` hay `everysec`.

## What Changes

- Thêm thư mục `spikes/redis-core/`: Redis 8 trong Docker có volume, library Redis
  Functions `sprinthub` (bản spike) và script TypeScript chạy kịch bản, kèm báo cáo.
- Viết 3 Function: `sh_create_task` (issue key, idempotency, kiểm tra membership
  trong Function), `sh_move_task` (chuyển trạng thái, `expectedVersion`,
  `lastClientMutationId`, chèn trung điểm, rebalance cột) và `sh_verify_task_indexes`.
- Chạy kịch bản song song và restart, đo latency Function, đo `MEMORY USAGE`, so
  sánh `appendfsync always` với `everysec`.
- Ghi kết quả vào `spikes/redis-core/REPORT.md`; cập nhật `docs/design/design.md`
  nếu số đo bác bỏ giả định nào.
- Không có API HTTP, UI hay deploy trong change này.

## Capabilities

### New Capabilities
- `redis-task-core`: lưu task trong Redis với issue key duy nhất, thứ tự cột bằng
  sparse integer, chuyển trạng thái có kiểm tra version và idempotency, và công cụ
  kiểm tra index. Spec này là nền cho các change P0 sau (task CRUD, board).

### Modified Capabilities
- (không có)

## Impact

- Code mới chỉ nằm trong `spikes/redis-core/`; Function nào đạt sẽ được chuyển vào
  library chính khi scaffold NestJS.
- Phụ thuộc: Docker, image `redis:8.x` (pin digest sau spike), Node 24, `redis`
  (node-redis), `tsx`.
- Có thể sửa `docs/design/design.md` (mục Persistence, Luồng nghiệp vụ) và ADR-005
  nếu số đo khác giả định.
