# Thiết kế nền BE

## Context

SprintHub dùng một Redis node làm database nghiệp vụ duy nhất (ADR-001, 003).
Spike đã kiểm chứng lõi task, outbox, idempotency và verifier. Nền BE cần giữ hợp
đồng đó khi đưa library vào runtime chung. Nguồn chính là thiết kế v1.7,
`openspec/specs/redis-task-core/spec.md` và `spikes/redis-core/REPORT.md`.

## Goals / Non-Goals

**Goals**

- Chạy API và worker từ cùng checkout với cài đặt tái lập được, cấu hình fail fast
  và shutdown có kiểm soát.
- Tạo hợp đồng HTTP và Redis dùng chung cho các change P0.
- Giữ hồi quy của ba Function spike trên Redis đã pin, gồm kiểm tra từ chối,
  concurrency, persistence, latency và verifier.

**Non-Goals**

- Route nghiệp vụ, auth, worker đọc stream và xử lý unassign, SSE/Pub/Sub thật,
  Search, backlog ghi lúc create task và verifier tổng toàn hệ thống.
- Publish image, đổi tag, kiểm tra tạm ở infra, deploy, backup/restore R2.

## Decisions

### Runtime và ranh giới module

- Một package pnpm ở root, một lockfile, Node 24 theo `.nvmrc`, TypeScript strict.
  Pin pnpm qua `packageManager`; chọn và khóa bộ NestJS, Swagger, node-redis và
  Vitest tương thích Node 24 khi triển khai. Spike đã kiểm chứng node-redis 6.3.1.
- Hai entrypoint `src/api` (HTTP) và `src/worker` (Nest application context).
  Cả hai dùng chung hạ tầng config, log và Redis. Chỉ tạo module health và module
  hạ tầng cần dùng. Các thư mục auth, users, workspaces, projects, tasks và sync
  xuất hiện khi có hành vi thuộc change tương ứng.
- Đường phụ thuộc theo v1.7 gồm Transport → Policy → Application → Domain →
  Repository → Functions. Controller xử lý DTO và HTTP, policy là nơi kiểm tra
  quyền sớm, application điều phối, domain giữ type/code độc lập Redis,
  repository dựng key và gọi Function. Không cache session, membership hay quyền
  trong process. Code nền cung cấp điểm nối cho policy và nghiệp vụ.
- Validate địa chỉ, port, prefix, thông tin kết nối theo process, timeout dương
  và version mong đợi khi bootstrap. Secret sai cấu hình làm process thoát với
  log đã che dữ liệu. SIGTERM dừng nhận việc mới, chờ việc đang chạy trong thời
  hạn shutdown rồi đóng các kết nối.

### Redis và library

- Dùng key builder chung với prefix mặc định `sh:v1:`; cấu hình prefix một lần
  và truyền cùng giá trị vào key builder, wrapper và ACL. Giữ dạng key gốc
  `{entity}:{id}` và type index riêng. Cấm lệnh `KEYS`/`SCAN` trong request.
  Verifier dùng `SCAN` offline với quyền maintenance.
- Kết nối request riêng, sẵn factory cho subscriber, `XREADGROUP BLOCK` và job
  admin. API/worker chỉ mở kết nối thực sự sử dụng; kết nối maintenance chỉ do
  entrypoint maintenance giữ. Blocking/subscriber dùng vòng đời riêng, không
  áp deadline request vào thời gian BLOCK đã cấu hình.
- Timeout request theo lệnh mặc định 200 ms, tắt offline queue, fail nhanh khi
  mất kết nối. Read side-effect-free có tối đa 2 lần retry trong deadline request
  khi còn thời gian, backoff + jitter. Reconnect backoff + jitter để phục vụ lệnh
  mới. Không tự mở lại hoặc phát lại lệnh mutation đã gửi. Lệnh bị timeout hoặc
  đứt socket sau khi có thể đã gửi trả `503 MUTATION_OUTCOME_UNKNOWN`. Client
  mutation nghiệp vụ giữ nguyên `Idempotency-Key` khi gửi lại. Lỗi từ chối trước
  gửi hoặc Redis trả OOM được map sang `503 REDIS_UNAVAILABLE`. Lỗi Lua/giao thức bất
  ngờ đã có reply trả `500 INTERNAL_ERROR` và log nội bộ. Kiểm chứng hành vi queue
  và timeout trên node-redis phiên bản lockfile. [Redis client production usage](https://redis.io/docs/latest/develop/clients/nodejs/produsage/).
- Với reply nghiệp vụ `KEYS_MISMATCH` xác nhận chưa ghi, caller có thể đọc lại
  metadata và gọi lại tối đa 2 lần trong deadline. Đây là đường khác timeout;
  hết số lần trả `503 REDIS_UNAVAILABLE`. Giữ decoder reply chuỗi JSON của spike
  và chỉ map các code/params nằm trong allow-list.
- Library chính ở `redis/functions/sprinthub.lua`. Dùng wrapper/decoder, fixture,
  verifier và suite spike làm baseline. Giữ các KEYS và ARGS cũ. Bổ sung
  `requestId` tùy chọn ở ARGS cuối cho ba hàm ghi hiện có như bảng, tăng
  `LIB_VERSION` từ 1 lên 2. Caller app luôn truyền ID, caller spike cũ có thể
  bỏ qua field mới. Giữ `eventId = workspaceId:seq` ổn định cho cùng event và
  giữ replay trả data/seq cũ. `requestId` nằm ngoài request hash, gắn một lần
  khi ghi event. HTTP trả ID của lần gọi hiện tại. Task API sau phải bổ sung
  ghi backlog (invariant 10) trước khi mở route create. Change membership
  sau hoàn thiện audit và ngữ nghĩa remove-member trước khi mở route hoặc
  bật consumer P0.

  | Function có sẵn | KEYS | ARGS của spike | ARGS mới |
  | --- | --- | --- | --- |
  | `sh_create_task` | Giữ 12 key theo spike | 10 | thứ 11 là `requestId?` |
  | `sh_move_task` | Giữ 9 key theo spike | 13 | thứ 14 là `requestId?` |
  | `sh_remove_member` | Giữ 6 key theo spike | 6 | thứ 7 là `requestId?` |
  | `sh_lib_version` | 0 | 0 | Giữ nguyên, gọi bằng `FCALL_RO` |

- Loader dùng `sh-maint` chạy `FUNCTION LOAD REPLACE` và kiểm tra đúng library,
  version bằng `FCALL_RO sh_lib_version 0`. Local Compose chạy loader one-shot
  sau khi Redis healthcheck qua, rồi mới khởi động API/worker. Deploy/migrate
  sau này nạp trước khi chuyển app sang phiên bản mới. Request, reconnect và
  startup API/worker chỉ thăm dò, không nạp library. Readiness kiểm kết nối
  Redis và version đúng với artifact đang chạy, kể cả sau khi reconnect. Khi
  rollback phải nạp lại library và khởi động API/worker cùng version tương ứng.
  [Redis Functions](https://redis.io/docs/latest/develop/programmability/functions-intro/) và [Docker Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/).

### HTTP và OpenAPI

- `/api/v1` là prefix nghiệp vụ. Probe `/health/live` và `/health/ready` ở
  root cho Compose và uptime checker. Liveness chỉ xét process, readiness
  xét Redis và library. Probe công khai trả payload tối thiểu.
- Middleware tạo `req_<ULID>` mỗi request trước khi xử lý DTO/route, ghi
  `X-Request-Id` và giữ cùng ID trong log và event. Dùng log JSON với redact
  cho cookie, credential, password và chi tiết nhạy cảm. Global filter,
  allow-list DTO, `Server-Timing` và `no-store` áp cả lỗi routed qua Nest.
- `contract.md` chốt hành vi trước code. Export `openapi.json` ở root từ cùng
  controller/DTO bằng NestJS Swagger, không cần nối Redis hay serve Swagger UI.
  CI sinh lại spec và báo drift. FE có thể dùng file này với
  `openapi-typescript` khi tích hợp. [NestJS OpenAPI](https://docs.nestjs.com/openapi/introduction).

### Compose và CI

- Dùng `redis:8.10.3@sha256:1f88291b4c57bdf249f02eb085a8669889b2d2954e91d4de5118a5da6b78dd53`
  cùng volume, AOF, `appendfsync always`, `no-appendfsync-on-rewrite no`,
  `aof-timestamp-enabled yes`, `aof-load-truncated yes`, RDB `save 900 1`,
  `maxmemory 512mb` và `noeviction` theo v1.7. Trên máy spike, max thao tác
  đã đo 1,390 ms trên Redis, p99 client trung vị 8,505 ms trong drill SIGKILL
  và 0/1.645 ACK bị mất. Dùng các số đó làm baseline cho test hồi quy.
- Redis trong mạng Compose nội bộ. API và worker dùng `sh-app`/`sh-worker`;
  loader, verifier và job maintenance dùng `sh-maint`. Cấu hình credential qua
  tệp môi trường local được ignore; `.env.example` chỉ khai tên/placeholder.
  Dùng allow-list lệnh và key pattern theo process, tắt user default. App/worker
  bị cấm `FLUSHALL`, `KEYS`, `SCAN`, `CONFIG` và thay library. Cấp quyền
  trên các lệnh Redis mà Lua thực sự gọi, chỉ repository Function được phép dùng
  quyền ghi trong luồng nghiệp vụ. Dùng test chứng minh ranh giới code vì ACL
  kiểm lệnh trong Function theo quyền của caller.
  [Redis ACL](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/).
- Lệnh pnpm/Makefile cho bootstrap, migration load, lint, typecheck, unit,
  integration và export OpenAPI. CI PR và push main cài từ lockfile, chạy secret
  scan và mỗi job integration có Redis + volume cô lập. Fixture và secret CI
  dùng một lần. Restart kiểm trên cùng volume của job. Test T-017 kiểm NOPERM,
  T-019 kiểm OOM qua repository/filter bằng fixture HTTP riêng trong test.

## Risks / Trade-offs

- Redis Functions thực thi tuần tự và giữ lại các ghi đã chạy khi Lua lỗi.
  Giữ preflight, verifier và test fault injection từ spike. Dùng SLOWLOG với
  ngưỡng 0 trong lượt cô lập để chứng minh max < 5 ms, tách khỏi thời gian fsync.
- Reconnect có thể đến sau lúc Redis đã commit. Test chủ động bỏ reply, đếm lần
  gửi và đối chiếu event/response khi client retry cùng key. Tham số timeout
  chỉ đổi khi có số đo.
- Library nâng version làm app cũ mất readiness trong lúc đổi process theo
  kiểm tra khớp tuyệt đối. Local dùng migration trước startup; cửa sổ rollout
  thuộc thiết kế deploy P1. Giữ chữ ký cũ để công cụ và đường rollback vẫn gọi
  được.
