# Spike: lõi Redis

Chứng minh Redis Functions giữ dữ liệu SprintHub đúng khi ghi song song, restart và
retry; đo latency và bộ nhớ; chốt bản Redis 8.x và `appendfsync`.

Kế hoạch và tiêu chí nằm trong [OpenSpec](../../openspec/changes/archive/2026-11-19-spike-redis-core).
Bản Redis đã pin và môi trường kiểm tra được ghi trong [REPORT.md](REPORT.md).

## Chạy

Chạy từ thư mục này với Docker Compose, Node 24 (theo `.nvmrc` ở gốc repo) và pnpm
theo phiên bản trong `package.json`. Nếu dùng Corepack, chạy các lệnh pnpm qua
`corepack pnpm`.

```bash
docker compose up -d
pnpm install --frozen-lockfile
pnpm seed
pnpm load
pnpm smoke
pnpm test
pnpm scenarios
pnpm scenarios:reset
pnpm persistence
pnpm bench
pnpm verify
pnpm exec tsc --noEmit
docker compose down
```

`pnpm seed` tạo một workspace, project `SHAPI` và ba membership (`OWNER`, `ADMIN`,
`MEMBER`) với ID cố định. Chạy lại giữ nguyên ID và các bản ghi đã có.
`pnpm smoke` kiểm cấu hình Redis và các lệnh `PING`, `JSON.SET`, `JSON.GET`,
`FUNCTION LIST` trên container thật.

- `REDIS_URL` mặc định là `redis://127.0.0.1:6390`.
- `REDIS_KEY_PREFIX` mặc định là `sh:v1:`. Ví dụ `REDIS_KEY_PREFIX=sh:test: pnpm seed`
  tạo fixture trong keyspace riêng.
- `pnpm seed --reset` xóa toàn bộ key bắt đầu bằng prefix đang chọn rồi tạo lại
  fixture. Chạy khi spike đang rảnh. Lệnh giới hạn ở Redis cục bộ cổng `6390`.

Redis lưu dữ liệu trong `./data`. `docker compose down` dừng container và giữ dữ
liệu cho lần chạy sau.

## Library và test integration

`pnpm load` dùng `FUNCTION LOAD REPLACE` để nạp `functions/sprinthub.lua` và in
phiên bản từ `FCALL_RO sh_lib_version 0`. Ba wrapper trong `src/functions.ts`
gọi `FCALL` và giải mã reply có cấu trúc.

`pnpm test` chạy cả unit test và integration test. Dùng
`pnpm test test/integration` để chạy riêng integration test. Các test này kết
nối Redis spike tại `127.0.0.1:6390`, tạo workspace và prefix riêng cho mỗi test,
rồi dọn dữ liệu fixture.

Khi retry move sang cột khác với `from` cũ, Function trả `KEYS_MISMATCH` ở bước
đối chiếu trạng thái trước khi tra idempotency. Caller đọc lại `task.status` và
gọi lại với `from` mới, giữ nguyên `Idempotency-Key` và payload gốc.

## Kịch bản chứng minh

`pnpm scenarios` chạy tuần tự 3.1–3.10 trên Redis spike đã nạp library. Để chạy
riêng một kịch bản, dùng `pnpm exec tsx scenarios/3.2-move-conflict.ts`. Mỗi lần
chạy dùng prefix ngẫu nhiên và workspace riêng, in bảng assertion PASS/FAIL và
thoát mã 1 nếu có lỗi. Các request song song dùng kết nối riêng.

Verifier chạy sau từng kịch bản trước khi dọn fixture. Hai kịch bản 3.9 và 3.10
so khớp chính xác báo cáo hỏng dự kiến. Kịch bản 3.9 nạp biến thể Lua riêng và
xóa biến thể sau khi thử lỗi.

Để chạy 3.11, dùng `pnpm scenarios:reset` khi Redis spike đang rảnh. Lệnh chạy
`seed --reset` trên prefix cấu hình, nạp lại library và chạy lại 3.1–3.10 với
verifier sau từng kịch bản.

## Persistence và benchmark

Chạy `pnpm persistence` sau `pnpm seed`, `pnpm load` và `pnpm scenarios` trên
container spike của worktree hiện tại. Script so snapshot trước/sau `docker restart`,
rồi dùng `docker kill -s KILL` và `docker start` trên cùng container ba lần cho mỗi
chế độ fsync. Mỗi lượt dùng `CONFIG SET` và kiểm tra lại bằng `CONFIG GET`. Khi
khởi động lại, Redis nạp cấu hình `appendfsync always` từ `redis.conf`. Client
ghi ID đã gửi và đã ACK vào NDJSON trong `logs/crash-logs/` và in đường dẫn lúc
chạy. `SIGKILL` giữ nguyên page cache của host, nên kết quả chỉ áp dụng cho crash
process.

Chạy tiếp `pnpm bench` để lấy p50/p99/max phía Redis từ `SLOWLOG` và số bộ nhớ từ
`MEMORY USAGE` và `INFO memory` với 5.000 task. Chạy từng lệnh tuần tự trên Redis
spike tại `redis://127.0.0.1:6390` khi không có workload khác. Hai phép thử dùng
fixture riêng. Benchmark khôi phục cấu hình slowlog khi kết thúc.

## Verifier

Chạy `pnpm verify` khi keyspace của spike đang rảnh. Verifier đọc hai chiều
giữa task JSON và `project-tasks`, các ZSET `board`, `workspace-task-keys`. Kết
quả là JSON với `ok` và `findings`, gồm các mục `missing`, `orphan`,
`duplicate`, `wrong-pointer` và `bad-score`. Có phát hiện thì lệnh thoát mã
1. Dùng `pnpm verify --report-only` nếu cần in báo cáo với mã thoát 0 kể cả khi
phát hiện index sai.
