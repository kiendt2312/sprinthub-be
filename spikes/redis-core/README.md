# Spike: lõi Redis

Chứng minh Redis Functions giữ dữ liệu SprintHub đúng khi ghi song song, restart và
retry; đo latency và bộ nhớ; chốt bản Redis 8.x và `appendfsync`.

Kế hoạch và tiêu chí nằm trong [OpenSpec](../../openspec/changes/spike-redis-core).
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

## Verifier

Chạy `pnpm verify` khi keyspace của spike đang rảnh. Verifier đọc hai chiều
giữa task JSON và `project-tasks`, các ZSET `board`, `workspace-task-keys`. Kết
quả là JSON với `ok` và `findings`, gồm các mục `missing`, `orphan`,
`duplicate`, `wrong-pointer` và `bad-score`. Có phát hiện thì lệnh thoát mã
1. Dùng `pnpm verify --report-only` nếu cần in báo cáo với mã thoát 0 kể cả khi
phát hiện index sai.
