# BE platform

## Purpose

Cung cấp vòng đời API/worker, hợp đồng lỗi HTTP và lớp Redis dùng chung cho
các capability P0 của SprintHub.

## ADDED Requirements

### Requirement: Runtime và cấu hình theo process

API và worker SHALL khởi động dưới dạng hai process độc lập từ cùng codebase
với cấu hình được validate trước khi phục vụ, và SHALL đóng kết nối khi shutdown.

#### Scenario: Env không hợp lệ
- **WHEN** API hoặc worker nhận Redis URL sai hoặc timeout không hợp lệ
- **THEN** process thoát với mã khác 0 và log không lộ credential

#### Scenario: Shutdown hai process
- **WHEN** API và worker đang chạy trong Compose nhận SIGTERM
- **THEN** cả hai dừng nhận việc mới, kết thúc trong deadline và đóng kết nối Redis

### Requirement: HTTP có hợp đồng lỗi và tương quan request

API SHALL từ chối field ngoài DTO, trả lỗi dạng `{error:{code,params},requestId}`
với `params` là object, và đặt `X-Request-Id`, `Server-Timing`, `Cache-Control: no-store`
trên response. Mỗi request SHALL có ID do server sinh, được dùng trong log và
truyền đến event phát sinh từ request đó.

#### Scenario: DTO nhận field ngoài danh sách
- **WHEN** request JSON gửi field ngoài allow-list của một DTO có mặt trong test fixture
- **THEN** nhận `400 VALIDATION_FAILED` trước lớp application, body và log đều khớp `X-Request-Id`, và response có `Server-Timing` cùng `no-store`

#### Scenario: Outbox từ wrapper mới
- **WHEN** wrapper lần lượt gọi create, move và remove-member trên fixture với request ID, rồi replay từng lệnh với cùng idempotency key và ID request mới
- **THEN** mỗi mutation ghi đúng một event và event giữ request ID của lần ghi ban đầu

### Requirement: Liveness độc lập và readiness theo library

API SHALL phục vụ `GET /health/live` theo trạng thái HTTP process và
`GET /health/ready` theo Redis và `LIB_VERSION` mong đợi. Worker SHALL dùng
cùng kiểm tra dependency trước khi sẵn sàng. Health SHALL giữ kín thông tin nội bộ.

#### Scenario: Redis mất kết nối
- **WHEN** Redis ngừng đáp ứng trong khi API vẫn chạy
- **THEN** live trả 200, ready trả `503 SERVICE_NOT_READY`, và worker báo dependency chưa sẵn sàng

#### Scenario: Library sai version sau reconnect
- **WHEN** Redis trả lời nhưng library thiếu hoặc có version sai
- **THEN** API vẫn live và ready trả 503; sau khi loader nạp đúng bản, ready trả 200

### Requirement: Redis timeout và thử lại có giới hạn

Lệnh request SHALL có deadline cấu hình được và offline queue tắt. Chỉ lệnh
đọc không side effect SHALL được retry tự động tối đa hai lần. Mutation
`FCALL` có reply bị mất hoặc quá hạn SHALL trả `503 MUTATION_OUTCOME_UNKNOWN`
và không được tự gửi lại. `KEYS_MISMATCH` xác nhận chưa ghi SHALL chỉ kích hoạt
đọc lại và thử lại tối đa hai lần. Request, subscriber, blocking và job
maintenance SHALL dùng kết nối riêng khi sử dụng.

#### Scenario: Mutation đã commit nhưng reply quá hạn
- **WHEN** Redis thực hiện ghi và test chặn reply đến quá deadline
- **THEN** một FCALL đã gửi, caller nhận 503; client gửi lại cùng key nhận data/seq cũ và Redis có đúng một lần ghi nghiệp vụ

#### Scenario: Redis offline và cạn bộ nhớ
- **WHEN** kết nối request chưa có hoặc Redis từ chối lệnh vì OOM
- **THEN** API trả `503 REDIS_UNAVAILABLE` trong deadline và không xếp mutation vào hàng đợi reconnect

#### Scenario: Đọc bị lỗi nhất thời
- **WHEN** lệnh đọc lỗi tạm thời và còn đủ deadline
- **THEN** wrapper thử lại tối đa hai lần với backoff và dừng sau khi đọc thành công hoặc hết deadline

### Requirement: Library và keyspace có vòng đời riêng

BE SHALL dùng library `sprinthub` nạp qua `FUNCTION LOAD REPLACE` bằng
entrypoint maintenance khi bootstrap local hoặc migration, giữ tương thích
chữ ký spike và dùng key builder chung với prefix mặc định `sh:v1:`.
Request path SHALL không thực thi `KEYS` hoặc `SCAN`.

#### Scenario: Chữ ký spike trên library mới
- **WHEN** loader nạp library vào Redis sạch và bộ test spike gọi ba hàm bằng chữ ký cũ
- **THEN** cả ba dùng cùng KEYS và semantics như spec `redis-task-core`

#### Scenario: Gọi qua credential runtime
- **WHEN** `sh-app` hoặc `sh-worker` thử chạy `KEYS`, `SCAN`, `FLUSHALL` hoặc nạp library
- **THEN** Redis trả NOPERM, còn FCALL được cấp quyền hoạt động với key thuộc prefix

### Requirement: Môi trường local kiểm được bằng CI

Compose SHALL chạy Redis pin digest từ spike, API, worker và bước load với ACL
riêng, AOF `appendfsync always` trên volume và `noeviction`. CI SHALL chạy
lint, typecheck, unit, secret scan, so OpenAPI sinh tự động và integration
với Redis thật cô lập theo job.

#### Scenario: Khởi động và restart cùng volume
- **WHEN** Compose khởi động sạch, tạo fixture qua library rồi restart Redis với cùng volume
- **THEN** probe trở lại ready, fixture và library vẫn tồn tại, verifier của spike báo sạch

#### Scenario: Contract health tái lập
- **WHEN** CI sinh OpenAPI từ cùng source hiện tại
- **THEN** chỉ có các route health của change này, schema lỗi và header khớp contract, và bản diff so với `openapi.json` là rỗng
