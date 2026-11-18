# Spike: lõi Redis

Chứng minh Redis Functions giữ dữ liệu SprintHub đúng khi ghi song song, restart và
retry; đo latency và bộ nhớ; chốt bản Redis 8.x và `appendfsync`.

Kế hoạch và tiêu chí: [openspec/changes/spike-redis-core](../../openspec/changes/spike-redis-core).
Kết quả sẽ ghi vào `REPORT.md`.

## Chạy

```bash
docker compose up -d        # Redis 8 + volume ./data
docker compose exec redis redis-cli PING
```

Cấu trúc dự kiến:

```text
compose.yaml      Redis 8 với redis.conf
redis.conf        AOF bật, noeviction, maxmemory nhỏ để thử OOM
functions/        library Lua `sprinthub` (bản spike)
scenarios/        kịch bản TypeScript (tsx + node-redis)
REPORT.md         kết quả đo và quyết định
```
