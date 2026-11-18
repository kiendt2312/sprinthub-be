# SprintHub — Spec dự án

Bản v1.7, 18/11/2026. Xuất từ Claude Docs (v1.3), cập nhật theo [design.md](design.md) v1.7 và 2 vòng review spec ngày 18/11/2026. File này là bản gốc: phạm vi, story, tiêu chí nghiệm thu, NFR. Chi tiết kỹ thuật nằm ở `design.md` và [ADR](../adr/README.md); spec chỉ dẫn tới, không chép lại.

## Tổng quan

SprintHub là app quản lý task cho team phần mềm 3–10 người, có Kanban, Sprint, Backlog và realtime. Một junior fullstack dev tự làm, không đặt mốc thời gian, với **Redis 8 là database nghiệp vụ duy nhất**.

| Mục | Nội dung |
| --- | --- |
| Mục tiêu sản phẩm | App dùng được, có demo URL, UI responsive, song ngữ EN/VI, đủ luồng task, sprint và phân quyền |
| Mục tiêu học tập | Tự thiết kế keyspace Redis, quan hệ không có foreign key, index phụ, concurrency, Functions, Streams, Search, persistence, bảo mật, test và deploy |
| Người dùng | Team phát triển nhỏ; người vận hành instance (Platform Admin) |
| Cảm hứng | Jira (Sprint, tách tầng admin), Linear (sync engine, Cycle), Plane (God Mode) |
| Ranh giới | Không PostgreSQL, MongoDB hay SQLite. File binary (P2) đặt ở object storage, metadata trong Redis. Không làm AI, billing hay microservices |
| Stack | Next.js + TypeScript (web, admin console), NestJS + TypeScript (API, worker, admin API), node-redis, Redis Open Source 8.x, Docker Compose, Vitest, Playwright, GitHub Actions |
| Repo | 5 repo cạnh nhau trong `SpirntHub/`: `sprinthub-be` (trung tâm: docs, OpenSpec, contract, library Function `sprinthub`), `sprinthub-fe` (thư mục local `sprinthub-ui`), `sprinthub-infra`, `sprinthub-admin-ui`, `sprinthub-admin-service`. Xem [REPOSITORIES.md](../REPOSITORIES.md) |
| Chạy ở đâu | Luồng **local → prod**, chi phí $0: prod trên 1 VM Oracle Always Free, domain DuckDNS, backup lên Cloudflare R2 |

Điều quyết định thành bại là **dữ liệu luôn đúng** khi nhiều người ghi cùng lúc, khi Redis restart, khi worker chết và khi request bị retry.

## Persona và vai trò

Hai tầng quản trị, giống Jira và Plane: tầng hệ thống (Platform Admin) và tầng workspace (Owner/Admin/Member). Platform Admin **không tự động** xem được nội dung workspace. Console và API của Platform Admin nằm ở 2 repo riêng (ADR-015).

| Vai trò | Tầng | Làm được | Không làm được |
| --- | --- | --- | --- |
| Platform Admin | Hệ thống | Suspend/reactivate user, thu hồi session, bật/tắt đăng ký, maintenance mode, xem health Redis, chạy verify/rebuild index, xem audit log, khôi phục Owner | Đọc task/comment nếu không phải member |
| Workspace Owner | Workspace | Mọi quyền của Admin, đổi role, xóa Admin, chuyển quyền Owner | Rời workspace khi chưa chuyển Owner |
| Workspace Admin | Workspace | Sửa setting, thêm/xóa Member, tạo/sửa/archive project, quản lý sprint | Đổi role, xóa Admin khác |
| Workspace Member | Workspace | Xem mọi project, tạo/sửa/move/assign task, label, comment, xóa task mình tạo, rời workspace | Sửa setting, quản lý member, sprint |
| Khách | — | Landing, login, register (nếu đăng ký đang bật) | Mọi thứ khác |

Role Guest và project riêng tư để P2.

## Phạm vi

P0 là lõi dữ liệu đúng và an toàn, chạy được bằng Compose ở local. P1 là bản deploy để đưa vào portfolio. P2 làm sau khi P1 đã xanh. Làm xong P0 mới sang P1.

| Ưu tiên | Tính năng |
| --- | --- |
| **P0 — MVP (local)** | Register/login/logout/logout-all, session thu hồi được, rate limit login theo IP và theo tài khoản · Workspace + membership + RBAC, đổi role, chuyển Owner, rời workspace · Project tạo/list/sửa/archive · Task tạo/sửa/xóa mềm, status, priority, due date, assignee, Markdown · Issue key `SHAPI-42` · Kanban kéo-thả, giữ thứ tự sau reload, cột tối đa 500 task (Function chặn, `409 COLUMN_FULL`) · Mutation queue phía client · Filter status/assignee/priority, cursor pagination · Tenant isolation, lỗi nhất quán · `Idempotency-Key` cho mutation nghiệp vụ · Song ngữ EN/VI, đổi ngôn ngữ · Index backlog ghi từ lúc tạo task (UI để P1) · **Worker tối thiểu**: consumer group tạo lúc bootstrap; `MEMBER_REMOVED` → lưu `job:{id}` rồi mới ACK, unassign theo batch có fencing, chạy tiếp sau crash; trim bằng `XTRIM … ACKED`; event lỗi 3 lần chuyển sang `stream:dead-letter` (có dedupe) + log; `XAUTOCLAIM` khi worker chết · AOF + RDB + volume, restart drill · Platform Admin qua **CLI** (grant/revoke, suspend/reactivate, revoke-sessions, bật/tắt đăng ký; danh tính operator lấy từ file ánh xạ trên VM) · Verifier offline · UI tối thiểu tự làm · Docker Compose, README · Bộ test P0 (bảng Test theo pha) |
| **P1 — Portfolio (deploy)** | Redis Search · Comment + activity · Sprint + UI Backlog · Label + filter label · Realtime bằng SSE + delta sync · Notification qua Streams (DLQ, dedupe) · Dashboard · Admin console `/admin` (`sprinthub-admin-ui` + `sprinthub-admin-service`), maintenance mode, apply repair, xem/replay dead-letter · Nâng giới hạn cột + job rebalance cột > 500 task (`BOARD_REBALANCE_REQUIRED`) · Đổi mật khẩu · Backup mã hóa lên R2, restore drill trên VM prod · CI: build multi-arch, PR đổi tag, kiểm tra tạm · E2E Playwright, load test · Deploy lên Oracle |
| **P2 — Để sau** | UI thiết kế qua Figma, invite qua email, reset mật khẩu, attachment, role Guest, project riêng tư, @mention, watcher, sub-task, story point + burndown, command palette, webhook/API token, presence, MFA cho admin, export audit, quota theo workspace, Grafana/Sentry, staging lâu dài, mua domain, SOPS |

**Không làm:** AI assistant, billing, multi-region, Redis Cluster/Sentinel, microservices, workflow editor tùy biến, offline-first kiểu Linear.

## User stories và tiêu chí nghiệm thu

Story chỉ xong khi tiêu chí đã có test chạy trên Redis thật. Cột "Thêm ở P1" là phần nghiệm thu bổ sung khi tính năng P1 tương ứng có mặt. Mã T-xxx là test trong `design.md`, mục Testing.

### P0

| ID | Module | User story | Nghiệm thu P0 | Thêm ở P1 | Test |
| --- | --- | --- | --- | --- | --- |
| US-01 | Auth | Là khách, tôi đăng ký bằng email/mật khẩu | 2 request cùng email song song chỉ tạo 1 tài khoản; Argon2id; response giống nhau dù email đã có; đăng ký đang tắt thì `403 REGISTRATION_DISABLED` | — | T-001 |
| US-02 | Auth | Là user, tôi đăng nhập, đăng xuất và đăng xuất mọi thiết bị | Session trong Redis, cookie HttpOnly/Secure/Lax; logout-all xóa mọi session; cùng IP lần login thứ 21 trong 15 phút bị `429`; cùng tài khoản lần thứ 6 trong 15 phút (từ IP khác nhau) bị `429`; user đã suspend login thì `401 USER_SUSPENDED` (kiểm `disabledAt` trong Function tạo session); logout bằng session đã bị thu hồi vẫn `204` | — | T-002, T-016 |
| US-03 | Workspace | Là user, tôi tạo workspace và trở thành Owner | Workspace JSON, membership OWNER, reverse index và slug unique tạo trong 1 Function; retry cùng `Idempotency-Key` không tạo workspace mới | — | T-008 (áp cho workspace) |
| US-04 | Workspace | Là Admin, tôi thêm hoặc xóa Member | Xóa member thì request kế tiếp của họ vào workspace bị `404`; worker unassign mọi task của họ trong workspace đó theo batch, task của họ ở workspace khác giữ nguyên; worker crash trước hoặc sau khi ACK `MEMBER_REMOVED` thì job vẫn chạy xong đúng một lần; job có epoch cũ bị từ chối; user được mời lại trước khi job chạy thì không bị unassign; không xóa được Owner | — | T-007, T-010 |
| US-05 | Task | Là Member, tôi tạo task và nhận mã `SHAPI-42` | 50 request song song ra 50 số khác nhau; mở được task theo key; assignee phải là member, kiểm tra **trong** Function; retry cùng key không tạo task thứ hai; cùng key khác payload bị `422` | — | T-004, T-008, T-009 |
| US-06 | Board | Là Member, tôi kéo task giữa các cột và thứ tự còn nguyên sau reload | Task nằm đúng 1 cột; chuyển sai sơ đồ trạng thái thì `422`; hai lần kéo hợp lệ liên tiếp từ cùng tab không gây `TASK_VERSION_CONFLICT`; cột hết khoảng trống thì được đánh số lại, thứ tự giữ nguyên, version task khác không đổi; tạo hoặc kéo sang cột đã có 500 task thì `409 COLUMN_FULL`, hai lệnh tranh slot cuối thì đúng một thành công; reorder trong cột đầy vẫn được; reload thấy đúng thứ tự | Tab khác tự tải lại cột khi nhận `rebalancedColumn` | T-005, T-006, T-012 |
| US-07 | Board | Là Member, khi người khác sửa cùng task, tôi thấy thông báo xung đột rõ ràng | 2 client cùng version hiện tại: 1 thành công, 1 nhận `409 TASK_VERSION_CONFLICT` kèm `currentVersion`; UI rollback, refetch, báo cho user | — | T-005 |
| US-08 | Query | Là Member, tôi lọc task theo status/assignee/priority | Với fixture cố định 250 task, duyệt hết các trang `limit=100`: không trùng, không thiếu, đúng bộ lọc; không bao giờ trả task của workspace khác | Lọc theo label | T-003 |
| US-09 | Isolation | Là user workspace khác, tôi không truy cập được task dù biết ID hay key | `404`, không lộ task tồn tại, cho mọi route đọc và ghi | — | T-003 |
| US-10 | Admin | Là Platform Admin, tôi suspend một user spam bằng CLI | Mọi session của user bị xóa, request kế tiếp bằng cookie cũ `401 SESSION_INVALID`, login lại `401 USER_SUSPENDED`; có audit entry với actor `cli:<adminId>` và user hệ điều hành; `reactivate` khôi phục được; không suspend hay revoke được admin active cuối cùng, kể cả khi 2 admin thao tác cùng lúc | Làm được từ console (sudo), stream SSE đang mở bị đóng | T-015, T-016 (phần session) |
| US-19 | Project | Là Admin, tôi tạo, sửa và archive project | Key 2–10 ký tự A–Z0–9, unique trong workspace; project archived ẩn khỏi danh sách mặc định; mutation nghiệp vụ **mới** của user vào nó trả `422 PROJECT_ARCHIVED`; ngoại lệ: Owner/Admin unarchive, worker unassign và admin repair, replay mutation đã thành công (trả response cũ). Kịch bản: archive → member trong tenant mở task qua key (chỉ đọc) → xóa một member, task của họ vẫn được unassign → unarchive → ghi lại bình thường. Member không tạo/archive được (`403`) | — | — |
| US-20 | Task | Là Member, tôi sửa và xóa task | Sửa bắt buộc `expectedVersion`; xóa mềm gỡ task khỏi mọi index active, key không được tái sử dụng; Member chỉ xóa được task mình tạo (test quyền: Member xóa task người khác → `403`) | — | — |
| US-21 | Workspace | Là Owner, tôi đổi role, chuyển Owner; là Member, tôi rời workspace | Luôn đúng 1 Owner; Owner không rời được khi chưa chuyển; đổi role có hiệu lực ngay ở request kế tiếp; Admin sửa được tên và slug workspace (slug unique, trùng thì `409`), Member sửa thì `403` | — | — |
| US-22 | i18n | Là user, tôi chọn EN hoặc VI | `PATCH /users/me` đổi `locale`; mọi lỗi trả `code` + `params`, FE có đủ bản dịch cả hai ngôn ngữ; khách dùng cookie hoặc `Accept-Language` | Notification render theo ngôn ngữ người xem | — |

### P1

| ID | Module | User story | Nghiệm thu | Test |
| --- | --- | --- | --- | --- |
| US-11 | Sprint | Là Admin, tôi start/complete sprint | Tối đa 1 sprint ACTIVE/project (`409 SPRINT_ALREADY_ACTIVE`); complete chuyển task chưa DONE sang sprint PLANNED khác hoặc backlog, task DONE ở lại | — |
| US-12 | Backlog | Là Member, tôi sắp xếp backlog và kéo task vào sprint | Đổi thứ tự backlog rồi reload: backlog đúng thứ tự mới, thứ tự board không đổi; kéo task vào sprint thì task rời `backlog` và vào `sprint-tasks` trong cùng Function, kéo ra thì ngược lại, verifier sạch | — |
| US-13 | Search | Là Member, tôi tìm task theo từ khóa | Với 2 workspace có cùng từ khóa và 1 task đã xóa mềm: kết quả chỉ có task active của workspace mình | — |
| US-14 | Realtime | Là Member, tôi thấy thay đổi của người khác trong < 1 s | Reconnect lấy delta theo `Last-Event-ID`; trang delta không cắt đôi nhóm cùng seq; cursor quá cũ thì `resync`; không áp event cũ hơn state đang có | T-011, T-012 |
| US-15 | Notification | Là assignee, tôi nhận thông báo khi được giao task hoặc có comment | Đúng **một** thông báo khi worker chết trước hoặc sau khi tạo notification; lần xử lý thứ 4 thất bại thì vào dead-letter, không chặn event sau | T-013, T-014 |
| US-16 | Comment | Là Member, tôi comment bằng Markdown | FE sanitize, không chạy script; xem được activity của task | T-018 |
| US-17 | Admin | Là Platform Admin, tôi xem health và chạy verify index trên console | `/admin` chỉ hiển thị metadata; admin-service ghi chỉ qua Function; verify chạy dry-run có báo cáo; không `SCAN` trong request | T-015, T-017, T-020 |
| US-18 | Ops | Là người vận hành, tôi khôi phục dữ liệu từ backup | Restore bản backup có thời điểm và dữ liệu đã biết vào Redis tạm: dữ liệu khớp tới thời điểm backup, thứ tự cột đúng, verify-invariants sạch, thời gian khôi phục được ghi lại | — |
| US-23 | Label | Là Member, tôi tạo, gắn và xóa label | Tên unique trong project; label thuộc đúng project; xóa label gắn với nhiều task chạy thành job batch có fencing (giống unassign), xong thì không task nào còn label đó | — |
| US-24 | Auth | Là user, tôi đổi mật khẩu | Cần mật khẩu cũ + sudo; mọi session khác bị thu hồi | — |
| US-25 | Dashboard | Là Member, tôi xem số task theo từng cột | `ZCARD` mỗi cột trong 1 round trip; số liệu khớp board | — |
| US-26 | Admin | Là Platform Admin, tôi reactivate user, thu hồi session, xem audit trên console | Hành động cần sudo; mọi hành động có trong `stream:audit`; không gỡ được admin cuối | T-015 |
| US-27 | Admin | Là Platform Admin, tôi bật maintenance mode để apply repair | Trong lúc bật, mutation của user thường trả `503 MAINTENANCE`, đọc vẫn chạy; tắt xong ghi lại bình thường | T-020 |

### Test theo pha

| Pha | Test (theo `design.md`) |
| --- | --- |
| Spike | Kịch bản 3.1–3.11 và 4.1–4.5 của `spike-redis-core` |
| P0 | T-001–T-010, T-012, T-015 (CLI revoke/suspend, 2 admin cùng lúc), T-016 (session), T-017–T-019, T-020 (verifier offline), T-021, restart drill |
| P1 | T-011, T-013, T-014, T-015 (qua console), T-016 (đóng SSE), T-020 (apply repair qua admin), E2E Playwright cả 2 ngôn ngữ, load test |

## Yêu cầu phi chức năng

Các con số là **mục tiêu thiết kế**, chưa phải kết quả benchmark; mỗi con số được đo và công bố cùng phương pháp đo.

**Kịch bản đo chuẩn** (dùng cho latency, round trip, tải): board 200 task chia 4 cột; tải thường 4 req/s, đỉnh 12 req/s; 80% đọc, 20% ghi, phần ghi chia cho ít nhất 5 actor để mỗi actor dưới 120 lệnh ghi/phút (rate limit); mỗi lượt 10 phút; k6 chạy từ máy ở Việt Nam tới VM. `http_req_duration` của k6 không tính DNS và thiết lập kết nối.

| NFR | Mục tiêu | Cách đo | Pha |
| --- | --- | --- | --- |
| Latency đọc board | p95 < 200 ms, p99 < 400 ms ở tải đỉnh, tỷ lệ lỗi < 0,1% | k6 theo kịch bản chuẩn + header `Server-Timing` để tách thời gian BE | P1 |
| Round trip Redis | Đọc board tối đa 3 batch mạng: (1) session + rate limit; (2) `project` `$.workspaceId` + 4 `ZRANGE`; (3) `HGET` membership + pipeline `JSON.GET` nhiều path, dữ liệu chỉ trả khi là member. Ghi = 1 `FCALL` sau guard | Integration test đếm batch (T-021) | P0 |
| Lệnh chậm | Mỗi Function: **max** < 5 ms trên workload nghiệm thu (p99 chỉ để quan sát); không `KEYS`/`SCAN` trong request | `SLOWLOG` với ngưỡng 0 trong lượt đo cô lập | Spike, P0 |
| Tính đúng | 100 lần move/assign song song không vi phạm invariant | Concurrency suite + verifier | P0 |
| Tenant isolation | Mọi test truy cập chéo trả `404` | IDOR suite | P0 |
| RPO crash | `always`: 0 lệnh đã ACK bị mất; `everysec`: khoảng 1 s (đo trong spike) | Kill drill | Spike |
| RPO mất VM | Tuổi bản backup **đã upload và restore được** ≤ 24 h | Restore drill hằng tuần | P1 |
| RTO | Restart < 1 phút. Mất VM: 15–30 phút tính từ lúc **có VM thay thế**; thời gian chờ cấp máy ghi riêng | Restore drill có bấm giờ, dựng lại VM ít nhất 1 lần | P0 (restart), P1 |
| Bộ nhớ | `used_memory` < 70% `maxmemory`; `maxmemory` ≥ 2× dataset đo được; RSS của mọi container cộng đỉnh copy-on-write lúc `BGSAVE`/rewrite và Redis tạm của restore drill < 80% RAM VM | `INFO memory`, `MEMORY USAGE`, `docker stats` lúc `BGSAVE` | P1 |
| Realtime | Event tới client < 1 s qua SSE; reconnect dùng `Last-Event-ID` | E2E đo thời gian từ response ghi tới event | P1 |
| Streams | Tuổi event pending cũ nhất < 10 phút, tính từ timestamp trong stream ID (không dùng idle time, vì idle reset mỗi lần giao lại); dead-letter = 0 ở tải bình thường | `XPENDING` lấy ID cũ nhất, `XINFO GROUPS` (lag) | P0 (worker), P1 |
| Bảo mật | Argon2id, cookie HttpOnly/Secure/Lax, CSRF, RBAC server-side, Redis ACL theo process, backup mã hóa, TLS tự gia hạn + HSTS, `Cache-Control: no-store` cho API | Security test + review | P0, P1 |
| UX | Mobile/tablet/desktop; state loading/empty/error/conflict; đủ bản dịch EN và VI | E2E Playwright cả 2 ngôn ngữ | P1 |
| Chi phí | $0/tháng: Oracle Always Free, GHCR và GitHub Actions cho repo public, DuckDNS, R2 trong 10 GB free | Không có dịch vụ trả phí; cảnh báo khi R2 vượt 8 GB | P1 |

Prod chạy trên **một VM Oracle Always Free** (2 OCPU / 12 GB, arm64). Always Free chỉ cấp ở home region của tenancy, nên Singapore là đích nếu home region là Singapore và còn capacity. Nếu Oracle hết máy hoặc thu hồi VM, dự phòng bằng máy nhà + Cloudflare Tunnel cho tới khi dựng lại được.

## Kiến trúc tóm tắt (HLD)

```text
Trình duyệt ── HTTPS ──> Caddy (TLS, DuckDNS)
                          ├─ /, /api/v1/*  → web (Next.js, sprinthub-fe) ── rewrite /api/v1/* → api
                          ├─ /api/v1/events → api (NestJS, sprinthub-be), đi thẳng để SSE không bị buffer
                          ├─ /admin         → admin-ui (Next.js, sprinthub-admin-ui)
                          └─ /admin-api/*   → admin-service (NestJS, sprinthub-admin-service)
api, worker (sprinthub-be) và admin-service ──> Redis 8 (JSON, index, Functions, Streams, Search)
worker: stream:domain-events → unassign, trim (P0); notification, rebalance cột lớn (P1)
backup: BGSAVE → RDB → mã hóa → Cloudflare R2
```

Trình duyệt không bao giờ nói chuyện trực tiếp với Redis. Mọi mutation nghiệp vụ và mọi thao tác ghi nhiều key đi qua một Redis Function; worker làm việc phụ ngoài đường găng. Keyspace (prefix `sh:v1:`, key gốc không có sub-key, ZSET là nơi duy nhất giữ thứ tự) nằm ở `design.md`, mục Keyspace.

| Câu hỏi | Quyết định | Vì sao | ADR |
| --- | --- | --- | --- |
| Database? | Redis 8 duy nhất: JSON gốc + index SET/ZSET/HASH | Mục tiêu học Redis làm DB chính, tự xây join, unique, transaction | 001, 002 |
| Ghi nhiều key cùng lúc? | Redis Function kiểm tra theo thứ tự: KEYS khớp ARGS → tenant thật → quyền → idempotency → điều kiện nghiệp vụ → ghi; reply JSON `{ok, code, params}` | Nguyên tử nhưng không rollback; kiểm tra ngoài Function gây write skew | 009 |
| Chống ghi đè? | `expectedVersion` bắt buộc + mutation queue phía client | Không âm thầm "ai ghi sau thì thắng", không tự gây `409` | — |
| Retry an toàn? | `Idempotency-Key` cho mọi mutation nghiệp vụ, lưu ở cuối Function theo actor, TTL 24 h. Auth và CLI không dùng `Idempotency-Key` và không cache response: register dựa vào email unique, login mỗi lần tạo session mới, logout và lệnh CLI cho cùng kết quả khi gọi lại | Timeout `FCALL` là "không rõ"; không lưu token phiên ngoài hash | 010 |
| Thứ tự board? | Số nguyên cách quãng 1024, chỉ nằm trong ZSET; rebalance trong cùng mutation, một event | Rebalance chỉ ghi một key; dễ debug hơn LexoRank | 005, 016 |
| Issue key? | `INCR project-task-seq` + HASH `workspace-task-keys` | Tên key biết trước khi gọi Function; số không tái sử dụng | 016 |
| Event? | Một stream chung + `workspace-seq` | `XADD` trong Function là outbox; seq cho delta sync | 004, 008 |
| Realtime? | SSE, `Last-Event-ID` = `seq` | Chỉ cần server → client; trình duyệt tự reconnect và gửi lại seq | 012 |
| Session? | Token opaque trong Redis, không JWT | Thu hồi ngay khi logout-all, suspend | — |
| Admin? | Platform Admin tách khỏi workspace; P0 bằng CLI trên VM (danh tính từ file ánh xạ user hệ điều hành → admin, Function kiểm admin còn active), P1 có console + API ở 2 repo riêng, ghi chỉ qua Function của BE | Chặn chiếm quyền; invariant nằm một chỗ. Redis ACL không ép được "chỉ ghi qua Function", nên quy tắc này do code và test giữ; ACL đọc của `sh-admin-svc` chỉ gồm key metadata, không gồm task/comment | 007, 015 |
| Ngôn ngữ? | EN + VI: BE trả `code` + `params`, FE dịch; `user.locale` | Không dịch ở BE | 014 |
| Repo? | 5 repo, `sprinthub-be` làm trung tâm; contract = OpenSpec `contract.md` + `openapi.json` sinh tự động | FE sinh type không lệch | 013 |
| Scale? | Một node trên một VM | Giả thuyết: quy mô demo 1–4 req/s, phải xác nhận bằng load test; SPOF chấp nhận với RTO 15–30 phút | 003 |
| Deploy? | Local → prod. CI build → PR đổi tag ở `sprinthub-infra/envs/prod` → kiểm tra tạm trong CI → merge → duyệt tay trong Environment `production` → SSH + Compose | $0, không Kubernetes/Argo CD; mỗi lần deploy là một PR | 011 |

## Definition of Done

Áp phần nào tùy loại change.

**Mọi change**

- [ ] Có proposal, design, tasks trong `openspec/changes/<change>/`; nhóm task đụng Redis kết thúc bằng bước kiểm tra trên Redis thật (theo `openspec/config.yaml`); change chỉ sửa docs hoặc UI thì không cần
- [ ] Sửa bug thì viết test tái hiện trước
- [ ] Cập nhật README hoặc docs liên quan, kèm bằng chứng test trong PR

**Change đụng API**

- [ ] Sửa `contract.md` trước code; `openapi.json` sinh lại; FE sinh lại type; chỉ thay đổi bổ sung, phá vỡ thì ra `/v2`
- [ ] Đi đúng Controller → Policy → Service → Repository → Function
- [ ] DTO allow-list, kiểm tra tenant, lỗi theo envelope `{error: {code, params}, requestId}`; thông điệp debug chỉ ghi vào log

**Change đụng invariant**

- [ ] Mọi điều kiện nằm trong Function; ghi rõ số invariant
- [ ] Có ít nhất 1 test nhánh từ chối (không ghi gì) và 1 test song song trên Redis thật
- [ ] Verifier báo đúng kết quả kỳ vọng sau test (sạch, hoặc đúng các lỗi của fixture cố tình làm hỏng)

**Change đụng UI**

- [ ] State loading/empty/error/conflict; đủ bản dịch EN và VI

## Demo nghiệm thu

### Demo P0 (local, Docker Compose)

1. Seed sẵn User A, B (cùng workspace sau bước 2) và User C ở workspace khác; C đang đăng nhập.
2. A tạo workspace và project `SHAPI`, thêm B với role Member.
3. A tạo 3 task `SHAPI-1`, `SHAPI-2`, `SHAPI-3`, giao `SHAPI-1` cho B, rồi kéo `SHAPI-3` lên đầu cột TODO.
4. B kéo `SHAPI-1` TODO → IN\_PROGRESS rồi ngay lập tức IN\_PROGRESS → IN\_REVIEW: cả hai thành công, không `409`.
5. A và B mở cùng task ở version hiện tại, cùng sửa title: đúng 1 bên thành công, bên kia thấy thông báo xung đột.
6. B (Member) không sửa được workspace setting: `403`.
7. C không mở được `SHAPI-1` dù biết ID hay key: `404`.
8. A xóa B khỏi workspace: B bị `404` ở request kế tiếp, `SHAPI-1` được unassign.
9. Restart container Redis: 3 task còn đủ, cột TODO vẫn là `SHAPI-3` rồi `SHAPI-2`, `SHAPI-1` ở IN\_REVIEW.
10. Chạy CLI suspend C: request kế tiếp của C bị `401 SESSION_INVALID`, có entry trong audit; reactivate C.
11. Chạy verifier offline: báo cáo sạch.

### Demo P1 (môi trường deploy thật)

1. Seed sẵn User A, B, C như demo P0; C đang đăng nhập và mở SSE.
2. A tạo workspace, project `SHAPI`, thêm B làm Member, tạo và **start** sprint 1.
3. A tạo task `SHAPI-1`, giao cho B, đưa vào sprint 1.
4. B kéo task TODO → IN\_PROGRESS; A thấy thay đổi trong < 1 s, không refresh.
5. B kéo cùng task IN\_PROGRESS → IN\_REVIEW ngay sau đó: không `409`.
6. A và B sửa cùng task ở version hiện tại: đúng 1 bên bị từ chối có kiểm soát.
7. B không sửa được workspace setting: `403`. C không mở được task: `404`.
8. B nhận notification khi được giao task và khi A comment.
9. Restart container Redis: task, thứ tự board và sprint vẫn còn.
10. Platform Admin suspend C trên `/admin`: session và SSE của C bị đóng, hành động có trong audit.
11. Admin chạy verify-invariants trên console: báo cáo sạch.
12. Restore backup đêm qua vào Redis tạm: verify sạch, thời gian khôi phục được ghi lại.

## Rủi ro và quyết định mở

| Rủi ro | Mức | Phòng ngừa |
| --- | --- | --- |
| Index lệch với dữ liệu gốc | Cao | Mọi ghi qua Function, verifier hai chiều + rebuild tool |
| Mất ZSET thì mất thứ tự kéo thả | Trung bình | AOF + backup giữ ZSET; rebuild theo `(createdAtMs, taskId)` chỉ cho thứ tự mặc định, thứ tự cũ lấy từ backup |
| Write skew (kiểm tra quyền ngoài Function) | Cao | Đọc membership trong Function, test song song |
| Retry sau timeout tạo trùng | Cao | `Idempotency-Key` kiểm tra và lưu trong cùng Function |
| Lệnh chậm chặn cả Redis | Cao | Ngân sách thời gian cho Function, cột ≤ 500 task, batch, `SLOWLOG` |
| Worker chết → stream không trim → hết RAM → mọi ghi hỏng | Cao | Worker có từ P0, trim bằng `XTRIM … ACKED`, cảnh báo tuổi pending, dead-letter tối thiểu, runbook |
| Rò dữ liệu giữa tenant | Cao | Function đối chiếu KEYS với tenant thật, policy tập trung, repository tự assert, `no-store`, IDOR test |
| Chiếm quyền Platform Admin | Cao | Bootstrap bằng CLI qua SSH, danh tính từ file ánh xạ do root sở hữu, quyền nằm ngoài user JSON, audit mọi lệnh, không gỡ được admin active cuối |
| Hai service cùng gọi library Function | Trung bình | `LIB_VERSION`, chữ ký tương thích ngược, deploy admin-service sau BE |
| Mất dữ liệu khi sự cố | Cao | AOF + RDB, backup RDB mã hóa lên R2, restore drill |
| Oracle không cấp máy ở home region | Trung bình | Kiểm tra home region trước; dự phòng máy nhà + Cloudflare Tunnel |
| Scope phình to | Cao | P0/P1/P2, DoD, làm xong P0 mới sang P1 |

**Quyết định còn mở**

- [ ] Bản Redis 8.x và image digest (chốt trong spike; đang thử 8.10.3)
- [ ] `appendfsync everysec` hay `always` (đo trong spike rồi chốt)
- [ ] Thư viện UI cho bản tối thiểu (chọn khi scaffold FE); thiết kế Figma ở P2
- [ ] Cách đăng nhập admin console: cùng domain, dùng chung session của BE (đề xuất, xác nhận khi làm P1)
- [ ] Home region của tenancy Oracle (kiểm tra trước khi tạo VM)
- [ ] Object storage cho attachment (P2)
- [ ] Admin có được xem nội dung khi khẩn cấp không (P2)
- [ ] Có role Guest không (P2)

**Chốt trong proposal P1** (đã biết, để change tương ứng giải quyết)

- **Delta sync:** đọc `LIMIT 0 501 WITHSCORES` để biết nhóm seq cuối có bị cắt; chọn bỏ hay giữ trọn nhóm cuối; cách tiến cursor khi cả nhóm bị lọc theo quyền; SSE phát trọn một nhóm trong một frame.
- **Notification:** `TASK_CREATED` có assignee cũng sinh notification; `processed` nghĩa là đã xong cho mọi người nhận; dedupe dead-letter khi crash giữa `XADD` và `XACK`; T-014 nghiệm thu "cuối cùng có đúng một".
- **Restore RDB:** khởi động Redis tạm với `appendonly no` trên volume sạch, đối chiếu ID, số lượng, thứ tự và invariant, rồi mới bật lại AOF khi dùng làm instance ghi; chỉ upload RDB của lượt `BGSAVE` đã thành công; backup dùng cho demo P1 chứa fixture đã biết.

**Đã chốt**

| Thời điểm | Quyết định |
| --- | --- |
| Review spec v1.6 → v1.7 | Cột P0 tối đa 500 do Function chặn (`COLUMN_FULL`); `PROJECT_ARCHIVED` chỉ cho mutation mới, có ngoại lệ unarchive, cleanup, replay; worker P0 lưu job rồi mới ACK, trim `ACKED`, dead-letter tối thiểu, unassign kiểm đúng workspace; CLI lấy danh tính từ file ánh xạ, T-015 vào P0; cookie đã thu hồi trả `SESSION_INVALID`; ngân sách đọc board 3 batch; Function max < 5 ms; dashboard chỉ đếm theo cột |
| Review spec 18/11/2026 (v1.6) | Worker tối thiểu vào P0; index backlog từ P0, UI ở P1; cột ≤ 500 ở P0, job rebalance lớn ở P1; auth và CLI không dùng cache response; CLI admin qua SSH với `sh-maint`, actor `cli:<adminId>`; demo tách P0 local và P1 deploy; UI P0 tự làm tối thiểu |
| Review spec spike (v1.5) | Thứ tự chỉ ở ZSET, HASH issue key, thứ tự kiểm tra trong Function, reply JSON, retry chỉ qua `Idempotency-Key`, move kèm rebalance một event |
| Grilling 18/11/2026 | Nhiều repo (v1.4: 5 repo), OpenSpec, SSE, song ngữ, local → prod, Oracle Free, DuckDNS, GitHub Environment secrets, backup R2, quan sát mức gọn, không roadmap |
