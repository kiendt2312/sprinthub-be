## Why

Toàn bộ thiết kế SprintHub dựa trên giả định: Redis Functions giữ được dữ liệu đúng
khi nhiều người ghi cùng lúc, khi Redis restart và khi request bị retry. Trước khi
dựng NestJS, Next.js hay hạ tầng, cần chứng minh giả định đó bằng code chạy thật và
số đo. Spike cũng chốt hai quyết định còn mở: bản Redis 8.x (image digest) và
`appendfsync always` hay `everysec`.

## What Changes

- Thêm thư mục `spikes/redis-core/`: Redis 8 trong Docker có volume, library Redis
  Functions `sprinthub` (bản spike) và script TypeScript chạy kịch bản, kèm báo cáo.
- Viết 3 Function:
  - `sh_create_task`: issue key qua `workspace-task-keys`, idempotency, kiểm tra
    membership của actor và assignee trong Function, outbox tối thiểu.
  - `sh_move_task`: bảng chuyển trạng thái, `expectedVersion`, idempotency, kiểm tra
    tenant và task neo, chèn trung điểm, rebalance cột ≤ 500 trong cùng một event.
  - `sh_remove_member`: bản tối giản, chỉ làm fixture cho kịch bản write skew.
- Viết verifier offline bằng TypeScript (`verify-task-indexes`), không phải Function.
- Chạy kịch bản song song, retry, lỗi giữa chừng và restart; đo latency Function,
  `MEMORY USAGE`, so sánh `appendfsync always` với `everysec`.
- Ghi kết quả vào `spikes/redis-core/REPORT.md`; cập nhật `docs/design/design.md`
  nếu số đo bác bỏ giả định nào.
- Không có API HTTP, UI, deploy, assign độc lập, worker hay Search trong change này.

## Capabilities

### New Capabilities
- `redis-task-core`: lưu task trong Redis với issue key duy nhất, thứ tự cột bằng
  sparse integer chỉ nằm trong ZSET, tạo và di chuyển task có kiểm tra quyền, version
  và idempotency trong Function, và verifier index. Spec này là nền cho các change P0
  sau (task CRUD, board).

### Modified Capabilities
- (không có)

## Impact

- Code mới chỉ nằm trong `spikes/redis-core/`; Function nào đạt sẽ được chuyển vào
  library chính khi scaffold NestJS.
- Phụ thuộc: Docker, image `redis:8.x` (pin digest ở task 1.2, trước mọi phép thử), Node 24, `redis`
  (node-redis), `tsx`.
- Thiết kế đã lên v1.5 trước khi code (ADR-016: thứ tự chỉ nằm trong ZSET, HASH
  `workspace-task-keys`; quy ước chung cho Function ghi: đối chiếu KEYS với tenant thật,
  kiểm tra quyền trước khi replay, reply JSON, retry chỉ qua `Idempotency-Key`). Có thể sửa
  tiếp mục Persistence và ADR-005 nếu số đo khác giả định.
