# Agent Instructions — sprinthub-be

`sprinthub-be` là backend của **SprintHub**: app quản lý task (Kanban, Sprint,
Backlog, realtime) cho team 3–10 người, với **Redis 8 là database nghiệp vụ duy
nhất**. Đây cũng là **repo trung tâm**: mọi session làm việc mở ở đây, kể cả khi
sửa các repo khác.

Trạng thái P0. Spike lõi Redis đã hoàn tất ([báo cáo](spikes/redis-core/REPORT.md)).
Nền NestJS API/worker, auth session và Platform Admin CLI đã archive. Workspace,
membership và worker unassign nằm trong change
[workspaces-and-membership](openspec/changes/workspaces-and-membership/).

## Bản đồ repo

Các repo nằm cạnh nhau trong thư mục cha `SpirntHub/`. Chi tiết ở
[docs/REPOSITORIES.md](docs/REPOSITORIES.md).

| Thư mục local | Remote | Vai trò |
| --- | --- | --- |
| `sprinthub-be` | `kiendt2312/sprinthub-be` | API + worker NestJS, Redis Functions, OpenSpec, contract, docs |
| `sprinthub-ui` | `kiendt2312/sprinthub-fe` | Next.js app cho user (tên thư mục cố ý là `-ui`) |
| `sprinthub-infra` | `kiendt2312/sprinthub-infra` | Compose, Caddy, deploy, backup, E2E |
| `sprinthub-admin-ui` | `kiendt2312/sprinthub-admin-ui` | Platform Admin console |
| `sprinthub-admin-service` | `kiendt2312/sprinthub-admin-service` | Platform Admin API; đọc Redis trực tiếp, **ghi chỉ qua Function** của library do repo này sở hữu |

## Nguồn sự thật

1. `openspec/specs/` — spec hiện hành; `openspec/changes/<change>/` — thay đổi đang làm
   (proposal, design, tasks, delta specs, `contract.md` nếu đụng API).
2. `docs/design/design.md` — thiết kế chi tiết v1.7 (gốc xuất từ Claude Docs v1.3). Từ khi có
   code, **repo là bản gốc**; sửa thiết kế ở đây, không sửa ở Claude Docs.
3. `docs/design/spec.md` — spec toàn dự án v1.7 (phạm vi, user stories, NFR, DoD).
4. `docs/adr/` — quyết định kiến trúc (ADR-001 … ADR-016).

## Quy tắc bắt buộc

- **Contract trước code.** Đổi API thì sửa `contract.md` của change trong repo này
  trước; FE sinh type từ `openapi.json` bằng `openapi-typescript`. Chỉ thay đổi kiểu
  bổ sung; thay đổi phá vỡ ra `/v2`.
- **Mọi điều kiện ảnh hưởng invariant nằm trong Redis Function** (membership, role,
  `expectedVersion`, idempotency key, fencing epoch, đếm admin/owner). API chỉ kiểm tra
  sớm để trả lỗi nhanh; Function mới quyết định.
- **Key gốc `{entity}:{id}` không có sub-key**; index dùng type riêng có gạch nối
  (`project-tasks:{id}`, `task-comments:{id}`). Prefix `sh:v1:`.
- **Không `KEYS`/`SCAN` trong request path.** Redis đơn luồng: mỗi lần chạy Function < 5 ms,
  đọc board ≤ 3 batch (pipeline + `JSON.GET` nhiều path).
- **`FCALL` timeout = kết quả không rõ**: không retry mù mutation; trả `503` để client
  retry với cùng `Idempotency-Key`.
- **Library Redis Functions `sprinthub` do repo này sở hữu**, kể cả Function admin. `sprinthub-admin-service` chỉ gọi `FCALL`; đổi chữ ký Function phải tương thích ngược và tăng `LIB_VERSION`.
- **Không giữ trạng thái trong RAM process** (session, membership, quyền).
- **BE không dịch chuỗi**: lỗi trả `code` + `params`, FE dịch EN/VI.
- **Test concurrency, persistence, Search, ACL trên Redis thật**, không mock.
- Không commit secret, `.env`, dữ liệu Redis. Repo public.

## Môi trường

Luồng **local → prod**. Prod là 1 VM Oracle Always Free (Singapore). PR đổi tag ở
`sprinthub-infra/envs/prod` phải qua bước kiểm tra tạm trong CI. Chi tiết ở mục
Deploy của `docs/design/design.md`.

## Công cụ

Node 24 (`.nvmrc`), pnpm, TypeScript, NestJS, node-redis, Vitest, Playwright (ở
`sprinthub-infra`).

## Git

- Trunk-based: `main` + feature branch ngắn. GitHub, public, MIT.
- Danh tính commit cho các repo SprintHub: `kiendt <kiendt2312.work@gmail.com>`
  (cấu hình cục bộ từng repo, không dùng email công ty).
- Không push hay tạo PR khi chưa được yêu cầu.
