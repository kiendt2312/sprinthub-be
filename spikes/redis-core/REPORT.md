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
| Node và pnpm | Node `24.22.2`, pnpm `12.21.0` |

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
