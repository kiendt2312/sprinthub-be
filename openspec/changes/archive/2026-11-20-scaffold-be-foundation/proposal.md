# Scaffold BE foundation

## Why

Spike đã chứng minh Redis Functions giữ được lõi task nhất quán trên Redis thật.
Các change P0 cần chung cách khởi động API và worker, gọi Redis, nạp library và
kiểm tra hợp đồng HTTP trước khi triển khai nghiệp vụ.

## What Changes

- Dựng NestJS trên Node 24, pnpm và TypeScript strict. API và worker là hai process
  trong cùng codebase, chia sẻ cấu hình, logging và hạ tầng Redis.
- Đưa library `sprinthub`, wrapper và test hồi quy từ spike vào vị trí chính thức.
  Thêm loader riêng dùng `sh-maint`, key builder, ACL local, chính sách timeout,
  reconnect và readiness theo `LIB_VERSION`.
- Thêm HTTP health, envelope lỗi, tương quan `requestId`, DTO allow-list,
  `Server-Timing`, `Cache-Control: no-store` và export `openapi.json` từ NestJS.
- Dựng Compose local, cấu hình mẫu, lệnh chạy và CI kiểm tra lint, typecheck, unit,
  integration trên Redis thật và secret scan. Luồng build/publish image và đổi tag
  prod thuộc P1.
- Worker ở mức bootstrap và shutdown. Consumer group, job unassign và API nghiệp vụ
  thuộc các change P0 tương ứng.

## Capabilities

### New Capabilities

- `be-platform` — runtime API/worker, health, hợp đồng lỗi HTTP, hành vi khi Redis
  lỗi và vòng đời library Redis.

### Modified Capabilities

## Impact

- Cây ứng dụng NestJS, `redis/functions/sprinthub.lua`, Compose local, test, CI và
  `openapi.json` ở repo BE. Contract ban đầu chỉ có health và envelope lỗi.
- `redis-task-core` tiếp tục mô tả hành vi lõi task. Giữ tương thích chữ ký spike
  khi bổ sung `requestId` vào outbox.
- Là điều kiện triển khai của `auth-session-and-cli-admin` và các change P0 sau.
