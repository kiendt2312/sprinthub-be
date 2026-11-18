# sprinthub-be

Backend của **SprintHub** — app quản lý task (Kanban, Sprint, Backlog, realtime)
dùng **Redis 8 làm database chính duy nhất**. Dự án học tập/portfolio cá nhân.

- Thiết kế: [docs/design/design.md](docs/design/design.md)
- Quyết định kiến trúc: [docs/adr/](docs/adr/)
- Spec và thay đổi: [openspec/](openspec/)
- Các repo liên quan: [docs/REPOSITORIES.md](docs/REPOSITORIES.md)

Trạng thái: đang làm spike lõi Redis
([openspec/changes/spike-redis-core](openspec/changes/spike-redis-core)).

Stack dự kiến: NestJS + TypeScript, node-redis, Redis Open Source 8 (JSON, Search,
Functions, Streams), Vitest. License: MIT.
