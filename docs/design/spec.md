# SprintHub — Spec dự kiến toàn bộ dự án

Bản v1.5, 18/11/2026. Xuất từ Claude Docs (v1.3) rồi cập nhật theo thiết kế v1.5 ([design.md](design.md)); từ đây **file này là bản gốc**.

## Tổng quan

SprintHub là app quản lý task cho team phần mềm 3–10 người, có Kanban, Sprint, Backlog và realtime. Một junior fullstack dev tự làm, không đặt mốc thời gian, với **Redis 8 là database nghiệp vụ duy nhất**.

| Mục | Nội dung |
| --- | --- |
| Mục tiêu sản phẩm | App dùng được, có demo URL, UI responsive, song ngữ EN/VI, đủ luồng task, sprint và phân quyền |
| Mục tiêu học tập | Tự thiết kế keyspace Redis, quan hệ không có foreign key, index phụ, concurrency, Functions, Streams, Search, persistence, bảo mật, test và deploy |
| Người dùng | Team phát triển nhỏ; người vận hành instance (Platform Admin) |
| Cảm hứng | Jira (Sprint, LexoRank, tách tầng admin), Linear (sync engine, Cycle), Plane (God Mode) |
| Ranh giới | Không PostgreSQL, MongoDB hay SQLite. File binary (P2) đặt ở object storage, metadata trong Redis. Không làm AI, billing hay microservices |
| Stack | Next.js + TypeScript (web, admin console), NestJS + TypeScript (API, worker, admin API), node-redis, Redis Open Source 8.x, Docker Compose, Playwright, GitHub Actions |
| Repo | 5 repo cạnh nhau trong `SpirntHub/`: `sprinthub-be` (repo trung tâm: docs, OpenSpec, contract, library Redis Functions `sprinthub`, `AGENTS.md`), `sprinthub-fe` (thư mục local `sprinthub-ui`), `sprinthub-infra`, `sprinthub-admin-ui`, `sprinthub-admin-service`. GitHub, public, MIT, trunk-based. Bản đồ chi tiết: [REPOSITORIES.md](../REPOSITORIES.md) |
| Chạy ở đâu | Luồng **local → prod**, chi phí $0: prod trên 1 VM Oracle Always Free (Singapore), domain DuckDNS, backup lên Cloudflare R2 |

Điều quyết định thành bại không nằm ở số màn hình. Nó nằm ở chỗ **dữ liệu luôn đúng** khi có nhiều người ghi cùng lúc, khi Redis restart, khi worker chết và khi request bị retry.

## Persona và vai trò

SprintHub có hai tầng quản trị, giống Jira và Plane: tầng hệ thống (Platform Admin) và tầng workspace (Owner/Admin/Member). Platform Admin **không tự động** xem được nội dung workspace. Console và API của Platform Admin nằm ở 2 repo riêng (`sprinthub-admin-ui`, `sprinthub-admin-service`, ADR-015).

| Vai trò | Tầng | Làm được | Không làm được |
| --- | --- | --- | --- |
| Platform Admin | Hệ thống | Suspend/reactivate user, thu hồi session, bật/tắt đăng ký, maintenance mode, xem health Redis, chạy verify/rebuild index, xem audit log, khôi phục Owner | Đọc task/comment nếu không phải member |
| Workspace Owner | Workspace | Mọi quyền của Admin, đổi role, xóa Admin, chuyển quyền Owner | Rời workspace khi chưa chuyển Owner |
| Workspace Admin | Workspace | Sửa setting, thêm/xóa Member, tạo/archive project, quản lý sprint | Đổi role, xóa Admin khác |
| Workspace Member | Workspace | Xem mọi project, tạo/sửa/move/assign task, label, comment, xóa task mình tạo | Sửa setting, quản lý member, sprint |
| Khách | — | Landing, login, register (nếu đăng ký đang bật) | Mọi thứ khác |

Role Guest và project riêng tư để P2.

## Phạm vi

P0 là lõi dữ liệu đúng và an toàn; P1 là bản đủ để đưa vào portfolio; P2 làm sau khi P1 đã xanh.

| Ưu tiên | Tính năng |
| --- | --- |
| **P0 — MVP** | Register/login/logout/logout-all, session thu hồi được, rate limit login tách theo IP và theo tài khoản · Workspace + membership + RBAC · Project CRUD + archive · Task CRUD, status, priority, due date, assignee, Markdown · Issue key `SHAPI-42` · Kanban kéo-thả, giữ thứ tự sau reload · Mutation queue phía client · Filter/pagination bằng cursor · Tenant isolation, lỗi nhất quán · Idempotency nguyên tử (`Idempotency-Key` là cơ chế retry duy nhất) · Song ngữ EN/VI · AOF + RDB + volume, restart drill · Platform Admin qua CLI, suspend user, bật/tắt đăng ký · Docker Compose, README, test cơ bản |
| **P1 — Portfolio** | Redis Search · Comment + activity · Sprint + Backlog · Label · Realtime bằng SSE + delta sync · Notification qua Streams (DLQ, dedupe) · Dashboard · Admin console `/admin` (`sprinthub-admin-ui` + `sprinthub-admin-service`) · Đổi mật khẩu · Backup mã hóa lên R2, restore drill trên VM prod · CI: build multi-arch, PR đổi tag, kiểm tra tạm trước khi lên prod · Integration/E2E/concurrency/security test · Deploy lên Oracle |
| **P2 — Để sau** | UI qua Figma (đang chờ), invite qua email, reset mật khẩu, attachment, role Guest, project riêng tư, @mention, watcher, sub-task, story point + burndown, command palette, webhook/API token, presence, MFA cho admin, export audit, quota theo workspace, Grafana/Sentry, staging lâu dài, mua domain, SOPS |

**Không làm:** AI assistant, billing, multi-region, Redis Cluster/Sentinel, microservices, workflow editor tùy biến, offline-first kiểu Linear.

## User stories và tiêu chí nghiệm thu

Mỗi story chỉ được coi là xong khi tiêu chí nghiệm thu đã có test chạy trên Redis thật.

| ID | Module | User story | Tiêu chí nghiệm thu | Ưu tiên |
| --- | --- | --- | --- | --- |
| US-01 | Auth | Là khách, tôi đăng ký bằng email/mật khẩu | 2 request cùng email chạy song song thì chỉ tạo 1 tài khoản; mật khẩu hash bằng Argon2id; response không tiết lộ email đã tồn tại | P0 |
| US-02 | Auth | Là user, tôi đăng nhập, đăng xuất và đăng xuất mọi thiết bị | Session lưu trong Redis, cookie HttpOnly/Secure/Lax; logout-all xóa mọi session; 1 IP thử 50 email thì bị `429` | P0 |
| US-03 | Workspace | Là user, tôi tạo workspace và trở thành Owner | Workspace JSON, membership OWNER, reverse index và slug unique được tạo trong 1 Function; retry cùng key không tạo workspace mới | P0 |
| US-04 | Workspace | Là Admin, tôi thêm hoặc xóa Member | Xóa member thì quyền bị thu hồi ngay; task được unassign theo batch; không xóa được Owner | P0 |
| US-05 | Task | Là Member, tôi tạo task và nhận mã `SHAPI-42` | 50 request tạo task song song cho ra 50 số khác nhau; mở được task theo key `SHAPI-42`; assignee phải là member, kiểm tra **trong** Function; retry cùng `Idempotency-Key` không tạo task thứ hai | P0 |
| US-06 | Board | Là Member, tôi kéo task giữa các cột và thứ tự còn nguyên sau reload | Task nằm đúng 1 cột; chuyển sai sơ đồ trạng thái thì `422`; kéo 2 lần liên tiếp không bị `409`; cột hết chỗ thì được đánh số lại mà người khác không bị `409`, chỉ tải lại cột | P0 |
| US-07 | Board | Là Member, khi người khác sửa cùng task, tôi thấy thông báo xung đột rõ ràng | 2 client cùng version: 1 thành công, 1 nhận `409 TASK_VERSION_CONFLICT` kèm `currentVersion`; UI rollback, refetch | P0 |
| US-08 | Query | Là Member, tôi lọc task theo status/assignee/priority/label | Cursor pagination; không bao giờ trả task của workspace khác | P0 |
| US-09 | Isolation | Là user workspace khác, tôi không truy cập được task dù biết ID | `404`, không lộ task tồn tại | P0 |
| US-10 | Admin | Là Platform Admin, tôi suspend một user spam | Mọi session và stream SSE bị đóng; có audit entry; cần nhập lại mật khẩu (sudo). P0 làm bằng CLI, console ở P1 | P0 |
| US-11 | Sprint | Là Admin, tôi start/complete sprint | Tối đa 1 sprint ACTIVE/project; complete chuyển task chưa DONE sang sprint kế hoặc backlog | P1 |
| US-12 | Backlog | Là Member, tôi sắp xếp backlog và kéo task vào sprint | Thứ tự backlog độc lập với cột board | P1 |
| US-13 | Search | Là Member, tôi tìm task theo từ khóa | `FT.SEARCH` luôn có filter workspace và loại task đã xóa | P1 |
| US-14 | Realtime | Là Member, tôi thấy thay đổi của người khác gần như ngay | Reconnect thì lấy delta theo `sinceSeq`; không áp event cũ hơn state đang có | P1 |
| US-15 | Notification | Là assignee, tôi nhận thông báo khi được giao task hoặc có comment | Không trùng khi worker crash; event lỗi 3 lần vào dead-letter | P1 |
| US-16 | Comment | Là Member, tôi comment bằng Markdown | FE sanitize, không chạy script; xem được activity của task | P1 |
| US-17 | Admin | Là Platform Admin, tôi xem health và chạy verify index | Trang `/admin` (`sprinthub-admin-ui`) chỉ hiển thị metadata; admin-service ghi chỉ qua Function; job có báo cáo dry-run; không dùng `SCAN` trong request | P1 |
| US-18 | Ops | Là người vận hành, tôi khôi phục dữ liệu từ backup | Restore sang instance riêng, invariant đạt, thời gian khôi phục được đo | P1 |

## Yêu cầu phi chức năng

Các con số dưới đây là **mục tiêu thiết kế**, chưa phải kết quả benchmark; mỗi con số phải được đo và công bố cùng phương pháp đo.

| NFR | Mục tiêu | Cách đo |
| --- | --- | --- |
| Latency đọc | p95 < 200 ms, p99 < 400 ms (đọc board, đo từ Việt Nam tới Singapore) | k6 + header `Server-Timing` |
| Round trip Redis | Đọc board ≤ 3 lượt (pipeline + `JSON.MGET`); ghi = 1 `FCALL` sau guard | Integration test đếm lệnh |
| Lệnh chậm | Mỗi Function < 5 ms; không `KEYS`/`SCAN` trong request | `SLOWLOG`, load test |
| Tính đúng | 100 lần move/assign song song không vi phạm invariant | Concurrency suite |
| Tenant isolation | Mọi test truy cập chéo trả `404` | IDOR suite |
| RPO | Crash: theo kết quả đo trong spike (`always` = 0 với lệnh đã ACK, `everysec` khoảng 1 s, có thể lâu hơn khi fsync chậm). Mất VM: ≤ 24 h (backup hằng ngày lên R2) | Kill drill, restore drill |
| RTO | Restart: < 1 phút. VM bị Oracle thu hồi: dựng lại từ repo infra + backup trong 15–30 phút | Restore drill có bấm giờ, thử dựng lại VM ít nhất 1 lần |
| Capacity | Redis `maxmemory` ≥ 2× dataset đo được; VM 12 GB còn dư cho fork và Redis tạm của restore drill; cảnh báo ở 70% | `INFO memory`, `MEMORY USAGE` |
| Tải | Quy mô demo khoảng 1–4 req/s, đỉnh ×3. Một node dư sức | Phép tính nhẩm + load test |
| Realtime | Event đến client < 1 s qua SSE; reconnect dùng `Last-Event-ID` | E2E |
| Streams | Tuổi event pending cũ nhất < 10 phút; dead-letter = 0 | `XINFO GROUPS`, cron cảnh báo |
| Bảo mật | Argon2id, cookie HttpOnly/Secure/Lax, CSRF, RBAC server-side, Redis ACL theo process, backup mã hóa, TLS tự gia hạn + HSTS, `Cache-Control: no-store` cho API | Security test + review |
| UX | Mobile/tablet/desktop; state loading/empty/error/conflict; đủ bản dịch EN và VI | E2E Playwright cả 2 ngôn ngữ |
| Chi phí | $0/tháng (Oracle Free, GHCR, GitHub Actions cho repo public, DuckDNS, R2 gói free) | Theo dõi hóa đơn, không có dịch vụ trả phí |

Prod chạy trên **một VM Oracle Always Free ở Singapore** (2 OCPU / 12 GB, arm64). Nếu Oracle hết máy hoặc thu hồi VM, dự phòng bằng máy nhà + Cloudflare Tunnel cho tới khi dựng lại được.

## Kiến trúc tóm tắt (HLD)

```text
Trình duyệt ── HTTPS ──> Caddy (TLS, DuckDNS)
                          ├─ /            → web (Next.js, sprinthub-fe)
                          ├─ /api/v1/*    → api (NestJS, sprinthub-be)  ── SSE /api/v1/events
                          ├─ /admin       → admin-ui (Next.js, sprinthub-admin-ui)
                          └─ /admin-api/* → admin-service (NestJS, sprinthub-admin-service)
api, worker, admin-service ──> Redis 8 (JSON + index + Functions + Streams + Search)
worker: đọc stream:domain-events → notification, unassign, rebalance lớn, trim
backup: BGSAVE → mã hóa → Cloudflare R2
```

Trình duyệt không bao giờ nói chuyện trực tiếp với Redis; mọi thao tác ghi đi qua một Redis Function nguyên tử, còn worker xử lý việc phụ như notification ngoài đường găng.

| Câu hỏi | Quyết định | Vì sao |
| --- | --- | --- |
| Database? | Redis 8 duy nhất: JSON gốc + index SET/ZSET | Mục tiêu học Redis làm DB chính, phải tự xây join, unique, transaction |
| Ghi nhiều key cùng lúc? | Redis Function: kiểm tra **mọi** điều kiện rồi mới ghi | Nguyên tử nhưng không rollback; kiểm tra ngoài Function gây write skew |
| Chống ghi đè? | `expectedVersion` bắt buộc + mutation queue phía client | Không âm thầm "ai ghi sau thì thắng", không tự gây `409` |
| Function kiểm tra gì trước? | KEYS khớp ARGS → tenant thật → quyền → idempotency → điều kiện nghiệp vụ → ghi; reply JSON `{ok, code, params}` | Bộ key sai tenant không lọt qua; gửi lại lệnh đã thành công nhận đúng response cũ; lỗi giữ được `params` |
| Retry an toàn? | `Idempotency-Key` bắt buộc cho mọi mutation; bản ghi lưu ở cuối Function khi thành công, theo actor, TTL 24 h | Timeout của `FCALL` là "không rõ"; đây là cơ chế retry duy nhất |
| Thứ tự board? | Số nguyên cách quãng 1024, **chỉ lưu trong ZSET** board/backlog; rebalance khi hết chỗ, cùng mutation và cùng một event | ZSET dùng thẳng, dễ debug hơn LexoRank; rebalance chỉ ghi một key (ADR-016) |
| Issue key? | `INCR project-task-seq` + HASH `workspace-task-keys` (`SHAPI-42 → taskId`) | Tên key biết trước khi gọi Function; số không tái sử dụng |
| Event? | Một stream chung + `workspace-seq` | XADD trong Function là outbox; seq cho delta sync |
| Realtime? | SSE, `Last-Event-ID` = `seq`; Caddy chuyển thẳng `/api/v1/events` sang API | Chỉ cần server → client; trình duyệt tự reconnect và gửi lại seq, delta sync gần như có sẵn |
| Session? | Token opaque trong Redis, không JWT | Thu hồi ngay khi logout-all, suspend |
| Admin? | Platform Admin tách khỏi workspace, bootstrap bằng CLI; console + API ở 2 repo riêng, ghi chỉ qua Function của BE | Giống Jira/Plane; chặn chiếm quyền; invariant vẫn nằm một chỗ |
| Ngôn ngữ? | EN + VI: BE trả `code` + `params`, FE dịch; `user.locale` | Không dịch ở BE, notification render theo người xem |
| Repo? | 5 repo, `sprinthub-be` làm trung tâm; contract = OpenSpec `contract.md` + `openapi.json` sinh tự động | Giống cách làm ở mosa, FE sinh type không lệch |
| Scale? | Một node trên một VM | 1–4 req/s; SPOF chấp nhận với RTO 15–30 phút |
| Deploy? | Luồng local → prod. CI build → PR đổi tag ở `sprinthub-infra/envs/prod` → kiểm tra tạm trong CI → duyệt tay → SSH + Compose lên Oracle Free | $0, không Kubernetes/Argo CD; mỗi lần deploy là một PR |

## Definition of Done

- [ ] Có business rule và API contract (OpenAPI) rõ ràng
- [ ] Đi đúng Controller → Policy → Service → Repository → Function
- [ ] DTO allow-list, kiểm tra tenant, lỗi theo envelope chuẩn
- [ ] Mọi điều kiện ảnh hưởng invariant nằm trong Function
- [ ] Unit + integration test trên Redis thật, có ít nhất 1 test lỗi và 1 test song song
- [ ] Sửa bug thì viết test tái hiện trước
- [ ] FE có state loading/empty/error/conflict
- [ ] Cập nhật API docs, README, kèm ảnh hoặc bằng chứng test trong PR

## Demo nghiệm thu, rủi ro và quyết định mở

Bản demo cuối khóa phải chạy trọn 12 bước dưới đây trên môi trường deploy thật.

1. User A đăng ký, tạo workspace và project `SHAPI`.
2. A thêm User B với role Member.
3. A tạo task, nhận mã `SHAPI-1`, giao cho B, đưa vào sprint đang chạy.
4. B thấy task trên board và kéo TODO → IN\_PROGRESS.
5. A thấy thay đổi gần như ngay, không cần refresh.
6. B kéo cùng task 2 lần liên tiếp thật nhanh và không nhận `409`.
7. A và B sửa cùng task với version cũ: 1 bên bị từ chối có kiểm soát.
8. B (Member) không sửa được workspace setting: `403`.
9. User C ở workspace khác không mở được task dù biết ID: `404`.
10. Restart container Redis: task, thứ tự board và sprint vẫn còn.
11. Platform Admin suspend C: mọi session của C bị đóng, hành động có trong audit log.
12. Admin chạy verify-invariants: báo cáo sạch.

| Rủi ro | Mức | Phòng ngừa |
| --- | --- | --- |
| Index lệch với dữ liệu gốc | Cao | Mọi ghi qua Function, verifier hai chiều + rebuild tool; thứ tự chỉ ở ZSET nên mất ZSET thì dựng lại theo `createdAtMs` |
| Write skew (kiểm tra quyền ngoài Function) | Cao | Đọc membership trong Function, test song song |
| Retry sau timeout tạo trùng | Cao | `Idempotency-Key` kiểm tra và lưu trong cùng Function |
| Lệnh chậm chặn cả Redis | Cao | Ngân sách thời gian cho Function, batch, `SLOWLOG` |
| Worker chết → stream không trim → hết RAM → mọi ghi hỏng | Cao | Cảnh báo tuổi pending, dead-letter, runbook |
| Rò dữ liệu giữa tenant | Cao | Policy tập trung, repository tự assert, `no-store`, IDOR test |
| Chiếm quyền Platform Admin | Cao | Bootstrap bằng CLI, quyền nằm ngoài user JSON |
| Hai service cùng gọi library Function | Trung bình | `LIB_VERSION`, chữ ký tương thích ngược, deploy admin-service sau BE |
| Mất dữ liệu khi sự cố | Cao | AOF + RDB, backup mã hóa lên R2, restore drill |
| Scope phình to | Cao | P0/P1/P2, DoD, làm xong P0 mới sang P1 |

**Quyết định còn mở**

- [ ] Bản Redis 8.x và image digest cụ thể (chốt trong spike; bản đang dùng thử: 8.10.3)
- [ ] `appendfsync everysec` hay `always` (đo trong spike rồi chốt)
- [ ] UI và thư viện FE (sau khi thiết kế Figma)
- [ ] Cách đăng nhập admin console: cùng domain, dùng chung session của BE (đề xuất, xác nhận khi làm P1)
- [ ] Dung lượng free của Cloudflare R2 và cách đẩy backup (khi viết runbook)
- [ ] Object storage cho attachment (P2)
- [ ] Admin có được xem nội dung khi khẩn cấp không (P2)
- [ ] Có role Guest không (P2)

Đã chốt trong buổi grilling 18/11/2026: nhiều repo (v1.4: 5 repo, admin tách riêng), OpenSpec, SSE, song ngữ, luồng local → prod, Oracle Free, DuckDNS, GitHub Environment secrets, backup R2, quan sát mức gọn, không roadmap.

Đã chốt sau 2 vòng review spec spike (v1.5): thứ tự chỉ ở ZSET, HASH issue key, quy ước kiểm tra trong Function, reply JSON, retry chỉ qua `Idempotency-Key`, move kèm rebalance một event.
