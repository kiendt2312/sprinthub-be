# sprinthub-be

Backend của **SprintHub** — app quản lý task (Kanban, Sprint, Backlog, realtime)
dùng **Redis 8 làm database chính duy nhất**. Dự án học tập/portfolio cá nhân.

- Thiết kế: [docs/design/design.md](docs/design/design.md)
- Quyết định kiến trúc: [docs/adr/](docs/adr/)
- Spec và thay đổi: [openspec/](openspec/)
- Các repo liên quan: [docs/REPOSITORIES.md](docs/REPOSITORIES.md)

Backend dùng NestJS, TypeScript, node-redis, Redis Open Source 8 và Vitest.
[Báo cáo spike lõi Redis](spikes/redis-core/REPORT.md). Giấy phép MIT.

## Chạy backend local

Cần Docker Compose, Node 24 và Corepack. Chọn Node theo `.nvmrc` trước khi khởi động.

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
SLOWLOG. Dùng tham số `original` để chạy nguyên bản spike. Chạy lần lượt với
suite Redis local.

## Auth và Platform Admin CLI

Đặt `AUTH_ORIGIN` bằng origin công khai của app, ví dụ
`https://sprint.example.test`. App web gọi BE qua rewrite cùng origin và giữ
header `Origin`. Mutation yêu cầu `X-CSRF-Protection: 1`. Dùng HTTPS khi thử
cookie `__Host-sh_session` trên trình duyệt. Chỉ khai IP hoặc CIDR của proxy tin
cậy trong `AUTH_TRUSTED_PROXIES`; mặc định API dùng IP của peer trực tiếp.
`make local-env` sinh khóa HMAC riêng cho bộ đếm quota IP.

Trên VM, cấu hình `REDIS_MAINT_URL` riêng cho operator và tạo
`/etc/sprinthub/cli-operators.json` do root sở hữu, cho nhóm operator đọc
và chỉ root được ghi. Ánh xạ tên tài khoản hệ điều hành với ID đã đăng ký:

```json
{"operator":"usr_<ULID>"}
```

Ở local, tạo file `.env.local` với quyền 0600 và đặt
`SPRINT_HUB_CLI_OPERATORS_JSON='{"operator":"usr_<ULID>"}'`. Thay
`operator` bằng tên tài khoản hệ điều hành thực tế. Lần grant đầu tiên,
operator chỉ có thể tự grant cho ID đã đăng ký trong mapping.

```sh
make build
node --env-file=.env dist/scripts/admin/cli.js --local grant "$OPERATOR_ID"
node --env-file=.env dist/scripts/admin/cli.js --local suspend "$TARGET_ID"
node --env-file=.env dist/scripts/admin/cli.js --local reactivate "$TARGET_ID"
node --env-file=.env dist/scripts/admin/cli.js --local revoke-sessions "$TARGET_ID"
node --env-file=.env dist/scripts/admin/cli.js --local revoke "$TARGET_ID"
node --env-file=.env dist/scripts/admin/cli.js --local registration off
node --env-file=.env dist/scripts/admin/cli.js --local registration on
node --env-file=.env dist/scripts/verify-auth.js
```

Trên VM chạy cùng entrypoint với cấu hình môi trường của operator và bỏ
`--local`. CLI in JSON gồm mã kết quả và `requestId` để đối chiếu audit.
Verifier đọc hai chiều user, index email/created, phiên và Platform Admin
khi đã ngừng ghi.

## Nghiệm thu P0 foundation và auth

Redis 8.10.3 theo digest trong Compose, AOF `appendfsync always` và
`noeviction`. Lượt nghiệm thu dùng volume riêng và Node 24.22.2.

| Kiểm tra | Kết quả local |
| --- | --- |
| Cài từ lockfile, lint, typecheck, OpenAPI và sinh type FE | Đạt |
| Vitest | 24 unit và 41 integration qua |
| Spike nguyên bản và chữ ký cũ trên library v3 | Mỗi lượt 43 test và 10 kịch bản qua |
| SLOWLOG với library v3 | Workload spike 500 task tối đa 1,318 ms. Workload auth tại trần 16 admin và 32 phiên ghi nhận tối đa 1,139 ms. |
| Restart cùng volume | Task, thứ tự, event, idempotency và library giữ nguyên. Phiên active giữ HASH và mốc hết hạn. API đạt readiness trong hạn kiểm 20 giây. Worker báo mất và hồi phục dependency. |
| Smoke HTTP và CLI | Hai probe 200 với LIB_VERSION 3. Đăng ký 202, login và đọc hồ sơ 200, logout-all 204 và cookie cũ 401. CLI grant/suspend thành công, từ chối revoke admin active cuối. |
| Shutdown và verifier | API và worker thoát mã 0 sau SIGTERM. Hai verifier báo sạch. |

Các lượt đo chạy trên máy local. Workflow GitHub Actions chạy khi mở PR hoặc
push vào `main`.
