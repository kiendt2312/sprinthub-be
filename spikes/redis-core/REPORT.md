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
