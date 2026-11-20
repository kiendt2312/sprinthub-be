# Công việc triển khai nền BE

## 1. Khởi động ứng dụng và môi trường local

- [ ] 1.1 Tạo package NestJS root dùng Node 24, pnpm lockfile và TypeScript strict. Tách entrypoint API/worker, dùng chung module config/log/Redis và xác thực env theo từng process.
- [ ] 1.2 Dựng Compose local với digest Redis đã pin, volume AOF/RDB và config `appendfsync always`, `noeviction`. Khai ACL local theo `sh-app`, `sh-worker`, `sh-maint`, gắn credential tương ứng và cấu hình `.env.example` không secret.
- [ ] 1.3 Thêm lệnh Makefile/pnpm cho khởi động, dừng và kiểm tra local. Xử lý SIGTERM để đóng kết nối sạch trong cả API và worker.
- [ ] 1.4 Kiểm tra trên Redis thật: chạy cấu hình Compose, xác nhận digest/version và config persistence; round trip RedisJSON với fixture, làm sai env để kiểm fail fast và xác nhận `NOPERM` cho `FLUSHALL`/`KEYS`/`SCAN` bằng credential runtime (T-017).

## 2. Repository Redis và library

- [ ] 2.1 Tái dùng key builder và decoder của spike. Bổ sung các đường kết nối riêng và chính sách timeout, reconnect, retry đọc, phân biệt `KEYS_MISMATCH`, OOM và mutation không rõ kết quả (invariant 17).
- [ ] 2.2 Đưa `sprinthub.lua` vào `redis/functions/`. Giữ contract KEYS/ARGS spike và thêm ARGS cuối tùy chọn `requestId` cho ba Function ghi. Pin version 2, kiểm event và retry giữ data/seq cũ (invariant 2, 3, 4, 5, 6, 8, 9, 13, 17 được kế thừa).
- [ ] 2.3 Thêm loader dùng `sh-maint` chạy khi migrate/bootstrap Compose. Thêm phép thăm dò bằng `FCALL_RO sh_lib_version 0` cho API/worker bằng credential riêng; không load trong request.
- [ ] 2.4 Kiểm tra trên Redis thật: nạp library, chạy hồi quy spike với chữ ký cũ và mới, concurrency, reject không ghi, lỗi giữa chừng, outbox có `requestId`, timeout bỏ reply rồi retry cùng key và verifier offline. So SLOWLOG max < 5 ms trên workload spike (invariant 2, 3, 4, 5, 6, 8, 9, 13, 17).

## 3. HTTP và hợp đồng health

- [ ] 3.1 Dựng middleware request context, header `X-Request-Id`, log có redact, `Server-Timing`, `no-store`, DTO allow-list và exception filter map lỗi theo contract.
- [ ] 3.2 Mở hai probe theo `contract.md` với liveness độc lập, readiness theo Redis và library. Sinh `openapi.json` từ NestJS và test fixture cho DTO/mutation trong suite, ngoài tập route xuất bản.
- [ ] 3.3 Kiểm tra trên Redis thật: gọi health ở trạng thái ready, Redis mất kết nối, thiếu/sai version rồi phục hồi. Thử DTO lạ và OOM qua fixture HTTP để đối chiếu envelope, header, log và 503 không lộ chi tiết (T-019).

## 4. CI và nghiệm thu vận hành local

- [ ] 4.1 Thêm GitHub Actions lint, typecheck, unit, secret scan, kiểm drift OpenAPI và integration với Redis/volume riêng mỗi job. Giữ secret CI ở runtime.
- [ ] 4.2 Viết README các lệnh local, quy trình loader, cách đọc health/log và export OpenAPI cho repo FE; ghi kết quả regression và restart drill.
- [ ] 4.3 Kiểm tra trên Redis thật: chạy luồng CI từ dữ liệu sạch; tạo fixture bằng Function rồi restart cùng volume, đối chiếu JSON/index/thứ tự, event, idempotency và library. Kiểm readiness phục hồi dưới một phút trong môi trường nghiệm thu và xác nhận API/worker đóng kết nối khi SIGTERM (invariant 4, 5, 8, 9, 13, 17).
