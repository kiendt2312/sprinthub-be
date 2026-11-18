# Spike: lõi Redis

Chứng minh Redis Functions giữ dữ liệu SprintHub đúng khi ghi song song, restart và
retry; đo latency và bộ nhớ; chốt bản Redis 8.x và `appendfsync`.

Kế hoạch và tiêu chí nằm trong [OpenSpec](../../openspec/changes/spike-redis-core).
Bản Redis đã pin và môi trường kiểm tra được ghi trong [REPORT.md](REPORT.md).

## Chạy

Chạy từ thư mục này với Docker Compose, Node 24 (theo `.nvmrc` ở gốc repo) và pnpm
theo phiên bản trong `package.json`.

```bash
docker compose up -d
pnpm install
pnpm seed
pnpm smoke
pnpm test
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
