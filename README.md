# sprinthub-be

Backend của **SprintHub** — app quản lý task (Kanban, Sprint, Backlog, realtime)
dùng **Redis 8 làm database chính duy nhất**. Dự án học tập/portfolio cá nhân.

- Thiết kế: [docs/design/design.md](docs/design/design.md)
- Quyết định kiến trúc: [docs/adr/](docs/adr/)
- Spec và thay đổi: [openspec/](openspec/)
- Các repo liên quan: [docs/REPOSITORIES.md](docs/REPOSITORIES.md)

Trạng thái: spike lõi Redis đã xong ([REPORT](spikes/redis-core/REPORT.md),
[change đã archive](openspec/changes/archive/2026-11-19-spike-redis-core)); đang viết các change P0.

Stack dự kiến: NestJS + TypeScript, node-redis, Redis Open Source 8 (JSON, Search,
Functions, Streams), Vitest. License: MIT.

## Chạy backend local

Cần Docker Compose, Node 24 và Corepack. Dùng Node trong `.nvmrc`, rồi chạy:

```sh
source ~/.nvm/nvm.sh
nvm use
make install
make up
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready
```

`make local-env` tạo `.env` quyền 0600 với ba credential riêng. Redis và HTTP
chỉ publish trên loopback. Dùng `REDIS_PORT=16391 make local-env` ở worktree
mới nếu cổng mặc định 16390 đã được sử dụng. Dùng `make redis-up` và `make load`
khi muốn chạy API/worker bằng `node --env-file=.env dist/src/api/main.js` và
`node --env-file=.env dist/src/worker/main.js` từ host. `make down` giữ volume.
Dùng `docker compose --profile runtime down --volumes` để xóa dữ liệu local.

Compose chờ Redis healthy rồi dùng loader một lần với `sh-maint`. Migration
nạp library trước khi khởi động lại API/worker. Hai process chỉ kiểm phiên
bản qua `FCALL_RO sh_lib_version 0`. Khi readiness trả 503, đối chiếu
`docker compose logs redis loader api worker`. Tra lỗi HTTP theo
`X-Request-Id`. Log JSON chỉ ghi các trường vận hành đã chọn.

```sh
make redis-up
make load
make check
make openapi
node --env-file=.env dist/scripts/verify-task-indexes.js
```

File `openapi.json` được sinh từ controller/DTO, không kết nối Redis khi export.
Repo FE có thể dùng OpenAPI TypeScript để sinh type từ file này. Verifier đọc
offline khi dữ liệu đã ngừng ghi. Integration suite restart Redis của chính
Compose project và kiểm tra run ID trước khi dừng container.

`scripts/check-spike-compat.sh <LIB_VERSION> --bench` chạy suite spike với
library hiện tại trong Compose riêng trên cổng 6390, gồm test chữ ký cũ và đo
SLOWLOG. Chạy tuần tự với suite Redis local.
