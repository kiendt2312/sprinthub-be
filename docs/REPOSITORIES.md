# Bản đồ repo SprintHub

`sprinthub-be` là điểm vào cho mọi công việc liên repo. Đọc `AGENTS.md` của repo
liên quan trước khi sửa.

| Repo | Thư mục local | Trách nhiệm |
| --- | --- | --- |
| [sprinthub-be](https://github.com/kiendt2312/sprinthub-be) | `SpirntHub/sprinthub-be` | NestJS API + worker; Redis Functions (`sprinthub` library); OpenSpec specs/changes; `contract.md` + `openapi.json`; tài liệu thiết kế và ADR; spike |
| [sprinthub-fe](https://github.com/kiendt2312/sprinthub-fe) | `SpirntHub/sprinthub-ui` | Next.js app cho user; song ngữ EN/VI; type sinh từ `openapi.json`; UI thiết kế qua Figma |
| [sprinthub-infra](https://github.com/kiendt2312/sprinthub-infra) | `SpirntHub/sprinthub-infra` | `base/` + `envs/prod/` (compose, Caddy, `redis.conf`, `image-tags.env`); deploy SSH lên Oracle; backup R2; restore drill; E2E Playwright; `make prod-like` |
| [sprinthub-admin-ui](https://github.com/kiendt2312/sprinthub-admin-ui) | `SpirntHub/sprinthub-admin-ui` | Platform Admin console: users, workspaces, health, jobs, audit, settings |
| [sprinthub-admin-service](https://github.com/kiendt2312/sprinthub-admin-service) | `SpirntHub/sprinthub-admin-service` | Platform Admin API (`/admin-api/v1`): đọc Redis trực tiếp bằng user `sh-admin-svc`, ghi chỉ qua `FCALL` tới library `sprinthub` của BE |

## Luồng giữa các repo

1. Thiết kế/contract đổi ở `sprinthub-be` (OpenSpec change) trước.
2. BE/FE merge `main` → CI build image multi-arch lên GHCR → tự mở PR đổi tag ở
   `sprinthub-infra/envs/prod`.
3. PR đó chạy kiểm tra tạm (compose + seed + E2E + migration + `FUNCTION LOAD`) →
   duyệt tay → deploy.
