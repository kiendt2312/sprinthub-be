# Báo cáo spike lõi Redis

## Môi trường kiểm tra

| Thành phần | Giá trị |
| --- | --- |
| Redis | Docker Official Image `redis:8.10.3` (Debian Trixie) |
| Digest OCI index | `sha256:1f88291b4c57bdf249f02eb085a8669889b2d2954e91d4de5118a5da6b78dd53` |
| Kiến trúc | Registry có manifest `linux/amd64` và `linux/arm64/v8`. Máy kiểm tra chạy `linux/amd64`. |
| CPU | AMD Ryzen 7 H 260 w/ Radeon 780M Graphics, 16 CPU logic |
| RAM | 30,15 GiB khả dụng theo `/proc/meminfo` (`MemTotal`) |
| OS | Ubuntu 26.04.1 LTS x86_64, kernel `7.0.0-43-generic` |
| Docker | Client/Engine `29.9.0`, Compose `v5.6.0` |
| Client | Node `24.22.2`, pnpm `12.21.0`, node-redis `6.3.1`, loopback `127.0.0.1:6390` |
| Volume AOF | Bind mount `./data` trên ext4, SSD NVMe cục bộ |

Ngày 18/11/2026, tag ổn định `redis:8` và tag `redis:8.10.3` trả về cùng OCI index
digest qua `docker buildx imagetools inspect`. `INFO server` trong container trả
`redis_version:8.10.3`. [Docker Official Image](https://hub.docker.com/_/redis).

Cấu hình ban đầu bật AOF, dùng `appendfsync everysec`, bật timestamp và
`aof-load-truncated`, giới hạn `maxmemory 256mb` với `noeviction`. So sánh hai
chế độ fsync, đo latency và bộ nhớ thuộc nhóm 4.

## Kiểm tra nhóm 1

- Hai lần chạy `pnpm seed` cho cùng 6 key, cùng ID, dữ liệu JSON, vai trò và
  reverse index. `--reset` giữ nguyên key nằm ngoài prefix được chọn.
- `pnpm smoke` qua `PING`, các giá trị `CONFIG GET`, round trip RedisJSON và
  `FUNCTION LIST`. `JSON.GET` nhiều JSONPath trả một mảng cho mỗi path, gồm
  `[null]` cho giá trị null và `[]` cho path thiếu.
- Vitest qua 13 test. TypeScript `tsc --noEmit` và OpenSpec `validate --strict`
  đều thành công.

## Kiểm tra nhóm 2

- `pnpm load` nạp `sprinthub` phiên bản 1. `pnpm smoke` báo một library
  trong `FUNCTION LIST` và các kiểm tra Redis đều qua.
- Vitest qua 42 test, gồm 29 integration test trên Redis 8.10.3. Kiểm tra
  snapshot của các nhánh từ chối gồm giá trị key và thời điểm hết hạn tuyệt đối.
- `pnpm verify` trên seed trả `ok: true` với danh sách phát hiện rỗng. Thử một
  entry board mồ côi có score 1.5 trả `orphan` và `bad-score`; mã thoát lần
  lượt là 1 theo mặc định và 0 với `--report-only`.
- TypeScript `tsc --noEmit` và OpenSpec `validate --strict` đều thành công.

## Các điểm cần thống nhất sau nhóm 2

- Kịch bản 3.2 kỳ vọng `TASK_VERSION_CONFLICT` ở request thua. Theo thứ tự kiểm
  tra trong thiết kế, FCALL thua gửi `from=TODO` nhận `KEYS_MISMATCH` trước. Khi
  caller đọc lại `from=IN_PROGRESS` và giữ `expectedVersion` cũ, Function trả
  `TASK_VERSION_CONFLICT` cùng `params.currentVersion`. Kịch bản 3.3 cũng cần
  đọc lại `from` trước khi replay.
- Thiết kế yêu cầu từ chối khi ID task do caller sinh đã tồn tại hoặc field
  issue key kế tiếp đã bị chiếm. Spike xem đây là lỗi dữ liệu nội bộ, trả lỗi
  giao thức Redis trước lệnh ghi đầu tiên. Danh sách chín mã lỗi nghiệp vụ áp
  dụng cho các trường hợp đã có mã trong thiết kế.
- Chữ ký spike chỉ truyền `clientMutationId` cho create/move, trong khi
  envelope ở thiết kế tổng có cả `requestId`. Stream spike dùng
  `eventId = workspaceId:seq` và các field có trong chữ ký. Remove Member áp
  bảng quyền Owner/Admin và ghi delta `member:{userId}`.
- Verifier giữ mapping issue key của task soft-delete theo invariant 9.
  Invariant 7 áp dụng cho index active `project-tasks` và `board`.

## Kiểm tra nhóm 3

Chạy ngày 19/11/2026 trên Redis 8.10.3 đã pin, Node 24.22.2, pnpm 12.21.0 và
node-redis 6.3.1. Thời gian kịch bản đo từ lúc mở kết nối đến khi chạy verifier
và dọn fixture. Lượt 3.11 còn tính thời gian reset seed và nạp lại Lua.

| Kịch bản | Assertion PASS | Lượt thường (ms) | Sau reset (ms) |
| --- | ---: | ---: | ---: |
| 3.1 Tạo đồng thời và va chạm issue key | 6/6 | 107,1 | 69,5 |
| 3.2 Hai move cùng version | 5/5 | 7,9 | 9,9 |
| 3.3 Idempotency create, move và remove | 10/10 | 17,0 | 24,1 |
| 3.4 Tenant, actor và cột nguồn cũ | 8/8 | 14,7 | 19,4 |
| 3.5 Membership và 100 cặp create/remove | 6/6 | 223,6 | 260,7 |
| 3.6 Nhánh từ chối move và reorder | 15/15 | 31,1 | 34,1 |
| 3.7 Thứ tự, rebalance và giới hạn cột | 8/8 | 568,0 | 514,5 |
| 3.8 Key sai kiểu trước lệnh ghi đầu | 3/3 | 6,4 | 6,8 |
| 3.9 Lỗi runtime sau khi đã ghi | 10/10 | 7,6 | 9,0 |
| 3.10 Sáu dạng hỏng index | 8/8 | 8,7 | 9,7 |
| Tổng 3.1–3.10 | 79/79 mỗi lượt | 994,5 | 960,6 |
| 3.11 Reset, nạp Lua, chạy lại và verify seed | 5/5 | | 1.598,0 |

- 3.1 dùng 50 kết nối. Cả 50 task nhận issue key liên tiếp. Một lần remove
  member đưa `workspace-seq` lên 51 trong khi `project-task-seq` vẫn là 50.
  Fixture tạm chiếm field `SHAPI-51` để kiểm tra từ chối và snapshot.
- 3.5 ghi nhận 50 create trước remove và 50 remove trước create trong mỗi
  lượt. Khi create đi trước, event `TASK_CREATED` có seq 1 và `MEMBER_REMOVED`
  có seq 2. Khi remove đi trước, chỉ có event `MEMBER_REMOVED` với seq 1.
- 3.7 rebalance sau lần chèn liền kề thứ 11. Reorder cột 500 task kèm rebalance
  mất 1,231 ms ở lượt thường và 1,002 ms ở lượt reset, đo phía client quanh
  lời gọi Function qua loopback. Ngân sách thời gian phía Redis thuộc nhóm 4.
- 3.9 tiêm lỗi sau `JSON.SET` thì verifier thấy thiếu `project-tasks` và board.
  Tiêm trước `XADD` thì verifier không báo lỗi index. Cả hai thiếu event và
  idempotency. Hai biến thể Lua tạm được xóa sau khi thử và mã nguồn của library
  đã nạp khớp trước và sau phép thử.
- 3.10 tạo 6 dạng hỏng và so khớp đúng 8 mục. Task bị bỏ khỏi cả hai active
  index có hai mục `missing`, còn task nằm hai cột có `duplicate` và
  `wrong-pointer` ở cột sai.
- Vitest qua 42 test, `pnpm verify` trả `ok: true` và `findings: []`, TypeScript
  `tsc --noEmit` kiểm tra cả các file kịch bản.

### Điểm đối chiếu với spec và thiết kế

- 3.2 kỳ vọng conflict ở tầng caller. FCALL thua ban đầu nhận `KEYS_MISMATCH`
  do gửi `from=TODO`. Caller đọc lại `IN_PROGRESS`, giữ nguyên
  `expectedVersion` và nhận `TASK_VERSION_CONFLICT` với `currentVersion: 8`.
  Assertion riêng kiểm tra reply JSON với `currentVersion: 7` như spec.
- 3.3 làm mới `from` từ JSON task trước khi replay move, theo quy ước caller
  trong thiết kế. Response, version, seq, event và hạn idempotency được giữ
  nguyên.
- 3.1 xác nhận quy ước nhóm 2 cho field issue key bị chiếm. Library báo lỗi
  giao thức Redis trước khi ghi vì spec chưa định nghĩa mã nghiệp vụ cho trường
  hợp dữ liệu nội bộ này. Snapshot xác nhận cả hai counter và các key khác
  giữ nguyên.

## Nhóm 4 · Persistence, latency và bộ nhớ

Đo ngày 19/11/2026. Chạy tuần tự 4.1–4.3 trên image Redis 8.10.3 đã pin, rồi
chạy lại cả ba trên cùng bind mount sau khi chốt `appendfsync always` trong
`redis.conf`. Bên dưới dùng số của lượt nghiệm thu cuối, kèm số server của lượt
`everysec` để đối chiếu.

### 4.1 · Restart thường

Chạy sau `pnpm seed`, `pnpm load` và khi 3.1–3.10 đã xanh. Fixture riêng tạo ba
task rồi move hai lần, lần cuối buộc rebalance. Snapshot so dữ liệu theo kiểu
Redis và thời điểm hết hạn tuyệt đối của key. Script dùng `FUNCTION LIST …
WITHCODE` trước và sau khi `docker restart` cùng container.

| Kiểm tra | Kết quả với `always` |
| --- | --- |
| Restart đến `PONG` | 564,7 ms |
| Library | `sprinthub`, danh sách Function và mã nguồn khớp |
| Snapshot và verifier | 21 key khớp, verifier sạch trước và sau |
| Thứ tự TODO sau rebalance | 3 task giữ nguyên thứ tự, score 1024 → 1536 → 2048 |
| `workspace-seq` | 5 → 5 |
| Idempotency | 5 giá trị còn hạn và cả 5 thời điểm hết hạn tuyệt đối khớp |

Lượt với `everysec` trước khi chốt cho cùng kết quả đối chiếu, `PONG` sau 525,8 ms.

### 4.2 · SIGKILL khi đang ghi

Mỗi lượt tạo fixture riêng gồm 1 workspace và 40 project. Dùng 32 kết nối writer,
mỗi kết nối có tối đa một request đang chờ, luân phiên project để tránh chạm trần
cột. Mỗi lệnh đi qua `sh_create_task` và có assignee. Trước khi ghi, script đặt
mode bằng `CONFIG SET`, xác nhận `appendonly yes`, `appendfsync` và
`no-appendfsync-on-rewrite no` bằng `CONFIG GET`. Sau 400 ACK đầu, script gọi
`docker kill -s KILL`. Client tiếp tục gửi tới lúc socket ngắt. Sau đó `docker
start` dùng cùng container và bind mount. Từng lượt ghi `taskId` đã gửi và đã ACK
vào NDJSON trong `logs/crash-logs/`. Kết nối tắt reconnect và offline queue.

P99 client dùng nearest-rank trên 400 ACK trước yêu cầu kill, đo quanh wrapper
`FCALL` qua loopback. Khoảng đo gồm xử lý phía Redis, fsync, hàng đợi, I/O và lịch
chạy client. Cột “Đang bay” tính ở phía client lúc gọi Docker. Cột “Chưa ACK”
đếm lệnh đã gửi mà client chưa nhận phản hồi sau khi các socket đóng. Hai mốc
đếm này trùng số ở sáu lượt dưới đây.

| Mode | Lượt | Đã gửi | ACK | Đang bay | Chưa ACK | Phục hồi | Phục hồi dù chưa ACK | Mất ACK | P99 client (ms) | Start → PONG (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `always` | 1 | 574 | 542 | 32 | 32 | 559 | 17 | 0 | 9,755 | 358,2 |
| `always` | 2 | 564 | 532 | 32 | 32 | 532 | 0 | 0 | 8,505 | 376,3 |
| `always` | 3 | 603 | 571 | 32 | 32 | 571 | 0 | 0 | 7,198 | 362,2 |
| `everysec` | 1 | 672 | 640 | 32 | 32 | 640 | 0 | 0 | 6,004 | 362,7 |
| `everysec` | 2 | 637 | 605 | 32 | 32 | 605 | 0 | 0 | 5,720 | 379,7 |
| `everysec` | 3 | 644 | 612 | 32 | 32 | 621 | 9 | 0 | 6,937 | 362,6 |

| Mode | P99 client (ms), min / trung vị / max | Đang bay và chưa ACK | Phục hồi dù chưa ACK | Mất ACK |
| --- | --- | --- | --- | --- |
| `always` | 7,198 / 8,505 / 9,755 | 32 / 32 / 32 | 0 / 0 / 17 | 0 / 0 / 0 |
| `everysec` | 5,720 / 6,004 / 6,937 | 32 / 32 / 32 | 0 / 0 / 9 | 0 / 0 / 0 |

Verifier sạch ở cả sáu lượt. Mỗi task phục hồi giữ đủ JSON, `project-tasks`,
board TODO, `workspace-task-keys`, `user-assigned`, `workspace-changes`, đúng một
`TASK_CREATED` và idempotency còn hạn có response khớp. Task vắng mặt không để
lại side effect mồ côi. Counter project, counter workspace và số event khớp số
task phục hồi. Việc một số task chưa ACK vẫn có trên Redis xác nhận trạng thái
không rõ khi mất kết nối, nên retry nghiệp vụ cần giữ cùng `Idempotency-Key`.

**Chốt `appendfsync always`.** Tất cả 1.645 ghi đã ACK còn sau ba lần kill. Redis
fsync AOF trước khi gửi phản hồi ở chế độ `always`, với chi phí p99 trung vị
thêm 2,500 ms trên workload này. Mức chênh phù hợp tải demo của SprintHub và
Redis là nơi duy nhất giữ dữ liệu nghiệp vụ. `everysec` cũng giữ đủ 1.857
ghi đã ACK trong phép thử. `SIGKILL` để nguyên page cache của host, nên kết quả
chỉ bao phủ crash process. Khi mất nguồn, `everysec` có thể mất khoảng một giây
ghi cuối. Mất nguồn, hỏng volume và thu hồi VM cần phép thử riêng. [Redis Open Source persistence](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).

### 4.3 · Latency phía Redis

Mỗi hàng dùng 100 mẫu. Mỗi mẫu chạy `SLOWLOG RESET`, một `FCALL`, rồi lấy đúng
entry của Function. Ngưỡng log là 0 µs, chiều dài 4096. P50 và p99 dùng
nearest-rank. `SLOWLOG` đo thời gian thực thi lệnh, nên bảng p99 client ở trên
bao phủ thêm I/O và chi phí flush AOF. Sau phép đo, script xác nhận cấu hình
slowlog đã về 10000 µs và 128 entry. [SLOWLOG GET](https://redis.io/docs/latest/commands/slowlog-get/).

| Mode | Function và đường chạy | p50 (µs) | p99 (µs) | Max (µs) |
| --- | --- | ---: | ---: | ---: |
| `always` | Create task | 111 | 242 | 258 |
| `always` | Move thường sang cột khác | 137 | 266 | 270 |
| `always` | Reorder kèm rebalance cột đủ 500 task | 481 | 986 | 1390 |
| `everysec` | Create task | 74 | 242 | 364 |
| `everysec` | Move thường sang cột khác | 86 | 259 | 269 |
| `everysec` | Reorder kèm rebalance cột đủ 500 task | 510 | 1203 | 1257 |

Mỗi reorder ép một khoảng giữa hai score liền kề ở cột 500 task. Đối chiếu đúng
100 event `TASK_MOVED` có `rebalancedColumn=TODO`, thứ tự cuối đúng và verifier
sạch. Max 1,390 ms ở cấu hình đã chốt, thấp hơn ngân sách 5 ms. Giữ trần 500
task/cột cho P0 và đo lại trên VM arm64 trước khi triển khai.

### 4.3 · Bộ nhớ với 10 project × 500 task

Một workspace, 10 project, mỗi project có cột TODO đủ 500 task. Tạo cả 5.000 task
qua Function, với tiêu đề ngắn, mô tả rỗng và không gán người phụ trách. Lấy
`INFO memory` ngay sau tạo fixture, trước khi tạo fixture latency. Dùng
`MEMORY USAGE SAMPLES 0` cho mọi key thuộc các họ dưới đây. [MEMORY USAGE](https://redis.io/docs/latest/commands/memory-usage/).

| Họ key | Số key | Tổng byte | Trung bình byte/key |
| --- | ---: | ---: | ---: |
| Task JSON | 5.000 | 7.744.160 | 1.548,8 |
| `project-tasks` SET | 10 | 362.860 | 36.286 |
| `board` TODO ZSET | 10 | 557.390 | 55.739 |
| `workspace-task-keys` HASH | 1 | 414.651 | 414.651 |
| `workspace-changes` ZSET | 1 | 688.121 | 688.121 |
| `stream:domain-events` | 1 | 1.710.772 | 1.710.772 |
| Idempotency STRING | 5.000 | 5.365.000 | 1.073 |

Task JSON dao động 1.536–1.552 byte. `used_memory` tăng từ 1.992.864 lên
17.257.480 byte (16,46 MiB tổng, tăng 14,56 MiB). `used_memory_rss` tăng từ
31.137.792 lên 41.361.408 byte (39,45 MiB tổng). Hai trường là số toàn process
tại thời điểm đọc, gồm cả chi phí Redis và dataset nền. Spike xác nhận cỡ
1,5 KiB cho task JSON ngắn. Dung lượng với comment, activity, Search, label,
backlog và đỉnh copy-on-write cần đo trên workload của các pha sau.

### Kết luận đối chiếu nhóm 1–3

- Bản ghi task đã có cùng `taskId` với idempotency key mới là lỗi cấp ID nội bộ.
  Issue field kế tiếp bị chiếm là lỗi nhất quán dữ liệu. Cả hai trả lỗi giao thức
  Redis trước khi ghi và giữ snapshot nguyên. Không thêm `TASK_ID_EXISTS` hay mã
  HTTP tương ứng. Library giữ `LIB_VERSION=1`.
- `eventId` của spike bằng `workspaceId:seq`. Event create/move mang
  `clientMutationId`. `requestId` thuộc phần envelope khi đưa Function vào BE.
- Move với `from` cũ trả `KEYS_MISMATCH` trước khi replay. Caller đọc lại cột
  nguồn và giữ nguyên `Idempotency-Key`. Cạnh tranh version nhận
  `TASK_VERSION_CONFLICT` sau lần gọi lại với version cũ, còn retry lệnh đã thành
  công nhận đúng response lưu trước đó.
- Verifier giữ permalink của task soft-delete trong `workspace-task-keys` và
  kiểm `project-tasks` cùng board theo tập task active.

Self-test cuối trên Redis đã pin chạy `pnpm smoke`, `pnpm persistence`,
`pnpm bench`, 43 test Vitest, `pnpm scenarios` (10/10), `pnpm scenarios:reset`
(3.11 PASS), `pnpm verify` (0 findings), `tsc --noEmit` và OpenSpec
`validate spike-redis-core --strict`.
