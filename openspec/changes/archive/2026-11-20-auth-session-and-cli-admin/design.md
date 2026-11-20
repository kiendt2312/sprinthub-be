# Thiết kế auth session và CLI Platform Admin

## Context

`scaffold-be-foundation` cung cấp NestJS, Redis repository, loader, ACL và HTTP
envelope. Change này áp dụng v1.7 cho US-01, US-02, US-10 và US-22. Quyền cấp
hệ thống nằm trong Redis SET và tách khỏi membership workspace (ADR-007, 009, 015).

## Goals / Non-Goals

**Goals**

- Đăng ký duy nhất theo email khi chạy song song. Thu hồi phiên có hiệu lực ở
  request kế tiếp, kể cả khi login chạy đồng thời với CLI suspend (invariant 14, 16).
- Guard xác thực bằng một batch Redis để giữ ngân sách đọc board ≤ 3 batch.
- Grant/revoke/suspend bảo vệ admin active cuối bằng Redis Function (invariant 15).
- Hồ sơ chỉ cho phép các field công khai, locale EN/VI, bảo vệ version và retry
  theo hợp đồng mutation của dự án (invariant 8, 17).
- Có contract đủ cho FE và test T-001, T-002, T-015, T-016 phần session.

**Non-Goals**

- Sudo, đổi mật khẩu, SSE, P1 admin console/admin-service, maintenance mode,
  đăng nhập liên kết, xác minh email và reset mật khẩu.
- UI, catalog bản dịch hoặc chọn locale khách ở FE. Không có role trong hồ sơ.

## Decisions

### Danh tính, đăng nhập và phiên

- Chuẩn hóa email bằng trim và lowercase ASCII toàn địa chỉ, không gộp alias.
  Dùng SHA-256 của email chuẩn hóa cho `user-email` và limiter tài khoản. Giữ
  `email` đã trim để hiển thị và lưu `emailNormalized` cùng digest nội bộ để
  Function đối chiếu mapping. `user:{id}` là JSON, `users-by-created` là ZSET
  score `createdAtMs`. Mặc định `locale=en`, avatar rỗng là `null`,
  `disabledAt/suspendedBy/lastLoginAt` ban đầu là `null`, version và schemaVersion
  bắt đầu ở 1. User ID do backend tạo dưới dạng `usr_<ULID>`.
- Hash Argon2id ngoài Lua, salt ngẫu nhiên cho từng hash. Baseline 64 MiB, 3 lần,
  4 lane, salt 16 byte, tag 32 byte theo RFC 9106. Chạy đo thời gian và bộ nhớ với
  số request đồng thời quy mô demo. Register hash cả khi email trùng; siết unique
  trong Function sau kiểm tra registration. Login verify một hash Argon2id đối
  với cả email không tồn tại (dummy hash cùng tham số). Sai credential luôn
  `401 INVALID_CREDENTIALS`; đúng credential nhưng user suspended mới được trả
  `401 USER_SUSPENDED`. Kiểm `disabledAt` và mapping thật trong Function tạo phiên.
  [RFC 9106 §4](https://datatracker.ietf.org/doc/html/rfc9106#section-4).
- Token là 32 byte CSPRNG mã hóa base64url. Cookie `__Host-sh_session` có
  `HttpOnly; Secure; SameSite=Lax; Path=/`, không Domain. Cookie hết hiệu lực
  sau 30 ngày hoặc khi bị xóa với cùng thuộc tính. SHA-256 token là định danh
  Redis, không lưu token thô, không log cookie, digest hay password hash. Login
  luôn cấp token mới. Nếu cookie trước đó thuộc cùng tài khoản, thu hồi phiên
  cũ trong cùng Function khi tạo phiên mới. Nếu cookie thuộc tài khoản khác,
  chỉ thay cookie phía trình duyệt. Đổi quyền Platform Admin thu hồi các phiên
  của đích, người dùng đăng nhập lại nhận token mới.
- `session:{digest}` là HASH chứa `userId`, ID công khai ngẫu nhiên `ses_<ULID>`,
  `createdAtMs`, `lastSeenAtMs`, `expiresAtMs`, `absoluteExpiresAtMs`. Redis
  đặt TTL tại hạn trượt, tối đa 30 ngày từ lúc tạo. Guard xác thực bằng một batch gồm `HGETALL session:{digest}`
  và `INCR` quota của route nếu đã biết key quota trước khi đọc phiên. Với
  fixed window, gửi `EXPIRE NX` cùng pipeline. Guard quyết định từ `userId`,
  `expiresAtMs` và `absoluteExpiresAtMs` trong HASH. Cần userId hợp lệ và cả
  hai hạn còn hiệu lực. Guard không gọi FCALL, đọc user JSON hoặc cache
  session trong process. Cookie thiếu, sai định dạng, hết hạn
  hoặc đã thu hồi trả `401 SESSION_INVALID` trên route bảo vệ. Board dùng
  batch 1 cho guard, batch 2 đọc project + ZSET và batch 3 kiểm membership +
  đọc task (T-021). [Redis pipelines](https://redis.io/docs/latest/develop/clients/nodejs/transpipe/).
- Suspend thu hồi tất cả phiên và đánh dấu user disabled trong cùng Function.
  Revoke quyền và revoke-sessions cũng xóa toàn bộ phiên của target ngay
  trong Function. Theo invariant 14, HASH phiên còn hiệu lực là đủ để xác
  thực user ở guard, còn Function login vẫn kiểm `disabledAt` trước khi tạo
  phiên. Sau khi suspend commit, cookie cũ nhận `401 SESSION_INVALID` ở
  request kế tiếp.
- Chỉ khi `lastSeenAtMs` cũ hơn ngưỡng cấu hình (mặc định 10 phút), xử lý
  gia hạn sau khi gửi response. `sh_touch_session` dùng Redis TIME, kiểm HASH
  còn tồn tại, đúng owner, có trong index, còn hạn và vẫn vượt ngưỡng.
  Sau đó cập nhật `lastSeenAtMs`, `expiresAtMs` và đặt `PEXPIREAT` tới
  `min(now + 7 ngày, absoluteExpiresAtMs)`. Touch đồng thời hoặc touch sau
  thu hồi/hết hạn có thể trả no-op. Lỗi chỉ ghi log theo requestId. Touch không
  chặn response hay tự gọi lại khi mất reply. Phần lớn request chỉ đọc phiên.
- `user-sessions:{uid}` là SET các digest. Giới hạn 32 mục/user để có thể
  khai đủ key và thu hồi trong một FCALL dưới 5 ms. Hash đã hết TTL có thể để
  lại member; list bỏ qua, login đối chiếu và dọn member stale khi tạo phiên.
  Đủ 32 phiên còn hiệu lực trả `409 SESSION_LIMIT_REACHED`, trừ khi login thay
  phiên hiện tại của cùng user. Không có job dọn định kỳ ở change này.
- Logout xóa một phiên. Logout-all xóa cả index và mọi hash phiên còn lại của
  user sau khi xác thực cookie gọi lệnh. Logout và logout-all với cookie thiếu,
  sai định dạng, hết hạn hoặc đã thu hồi trả 204, xóa cookie và giữ nguyên
  các phiên khác. Timeout trả 503 và giữ cookie. Route bảo vệ đọc Redis lại
  ở request kế tiếp. Request đã qua guard có thể chạy tiếp. Function sửa hồ sơ
  và thu hồi phiên tự phục vụ kiểm lại owner, index và cả hai hạn của cookie
  trước khi ghi. Nếu cookie mất hiệu lực giữa lúc đọc snapshot và FCALL
  logout-all, Function trả no-op và giữ các phiên khác.
- CSRF chỉ áp cho mutation HTTP POST/PATCH/DELETE, kể cả login, register
  và logout. Mutation bắt buộc `X-CSRF-Protection: 1` và `Origin` khớp origin
  công khai đã cấu hình gồm scheme/host/port. Thiếu hoặc sai trả
  `403 CSRF_INVALID` trước khi kiểm session hoặc tính quota. GET dùng cookie
  hợp lệ và được miễn kiểm CSRF. Gia hạn điều tiết là tác vụ nội bộ. Các
  route này chạy cùng origin qua FE rewrite, giữ `Origin` và không mở CORS.
  Khi đối chiếu với cấu hình tĩnh,
  tránh suy origin từ `Host` hay `X-Forwarded-Host`. Dùng HTTPS khi kiểm cookie
  trong browser.
  [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

### Limiter và hồ sơ

- Limiter login/register và ghi hồ sơ dùng `INCR` + `EXPIRE NX` trong
  `sh_take_auth_rate_limit` ở tầng ứng dụng. PATCH cần `userId` từ guard để
  tính quota 120/phút theo user. Đây là bước của mutation sau guard, không
  phát sinh batch xác thực thứ hai. Board giữ ngân sách ba batch. Fixed
  window bắt đầu từ request đầu của key. Giữ key không có hậu tố window theo bảng rate limit
  chi tiết v1.7. Login tính cả hai cửa sổ (IP 20/900 giây, tài khoản 5/900 giây)
  cho mọi lần thử hợp lệ về CSRF/DTO, kể cả login thành công, email không tồn
  tại và retry. Register 3/3.600 giây theo IP; PATCH hồ sơ 120/60 giây theo user.
  Không tiếp tục hash password hoặc sửa hồ sơ khi quota cạn. Từ lần vượt ngưỡng
  trả 429; `Retry-After` là thời gian còn lại lớn nhất trong các cửa sổ đang
  chặn, tính từ `PTTL` và làm tròn lên theo giây.
  IP canonical lấy từ peer trực tiếp hoặc proxy đã cấp trust rõ ràng; mặc định
  bỏ qua forwarded IP. Dùng HMAC-SHA256 cho IP với secret env riêng và không
  lưu IP thô trong limiter. `RateLimit` theo định dạng cố định trong contract.
  Limiter SSH không thuộc change này; giới hạn admin HTTP sẽ được chốt ở P1.
  [Redis EXPIRE](https://redis.io/docs/latest/commands/expire/) và [IETF RateLimit draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/).
- `GET /users/me`, login và PATCH trả cùng projection Profile. GET sessions
  chỉ trả public ID, thời hạn, thời gian và cờ phiên hiện tại, sắp xếp theo
  `createdAtMs` giảm dần rồi ID tăng dần. Repository đọc index đã giới hạn
  và pipeline HASH, bỏ entry hết hạn, thiếu hoặc lệch owner. Không dùng SCAN.
- `PATCH /users/me` là mutation nghiệp vụ ngoài `/auth/*`: bắt buộc
  `expectedVersion`, `Idempotency-Key` và `X-Client-Mutation-Id`. Version
  kiểm trên user JSON sau replay. Login (ghi lastLoginAt), suspend, reactivate
  và PATCH có thay đổi tăng version user. PATCH giữ nguyên version nếu giá trị
  giống hiện tại, nhưng lưu kết quả idempotency. Replay trả projection cũ với
  requestId của lần gọi hiện tại. Không có workspace scope/seq cho auth, profile
  và CLI; reply thành công nội bộ dùng `seq:null`, HTTP không có `seq`.
  Profile dùng `version` để đồng bộ. Change này chỉ ghi audit stream cho CLI.
  Auth không ghi cache response, nhất là response chứa session token.

### CLI admin và audit

- CLI dùng `sh-maint` qua tài khoản SSH được cấp quyền chạy lệnh. VM lấy OS user
  từ UID hiệu dụng và tra `/etc/sprinthub/cli-operators.json` do root sở hữu,
  operator chỉ đọc. Từ chối file/ánh xạ thiếu, không tin `USER` hoặc tham số
  client làm danh tính; không có `--as`. Local dùng danh tính từ `.env.local`
  chỉ khi chạy rõ chế độ local. Credential chỉ cấp cho CLI/migration.
- Lệnh grant thường và các lệnh còn lại yêu cầu operator có tên trong
  `platform-admins` và user thật chưa bị disable, kiểm trong Function. Lần
  grant đầu cho phép SET rỗng, nhưng ID target phải trùng ID mapped operator
  và user đó đã đăng ký, còn active. Mọi target phải là user tồn tại. Grant
  yêu cầu target active, revoke có thể gỡ cả membership suspended. Quyền
  admin chỉ được cấp qua CLI trong P0.
- SET chứa cả admin suspended. Giới hạn tối đa 16 thành viên để kiểm active
  trên toàn snapshot dưới 5 ms. Revoke gỡ membership, suspend giữ membership
  và tắt user, reactivate bật lại user. Revoke/suspend admin active bị từ chối
  bằng `LAST_PLATFORM_ADMIN` nếu không có admin active khác ngay trong Function.
  Suspend xóa mọi phiên trước khi đặt `disabledAt/suspendedBy`, trong cùng
  Function. Reactivate chỉ cho phép tạo phiên mới qua login. Nếu phát hiện
  index phiên còn sót trên user disabled, CLI revoke-sessions xử lý trước
  khi reactivate. Grant/revoke có thay đổi cũng thu hồi phiên của target.
- Function chỉ chấp nhận setting `registrationEnabled` với giá trị `1|0`;
  field thiếu nghĩa là bật. Đổi setting và register dùng cùng key, thứ tự
  chạy Function quyết định kết quả. Không có đường ghi trực tiếp từ CLI.
- Mỗi lệnh có hiệu lực ghi một entry vào `stream:audit` trong Function, gồm
  `type`, `actor=cli:<adminId>`, `osUser`, `targetId` hoặc `setting/value`,
  `requestId`, `occurredAt`. Dùng stream entry ID do Redis cấp. No-op thành
  công và lệnh bị từ chối không ghi audit nghiệp vụ; outcome vẫn có log
  vận hành theo request ID. CLI trả exit 0 với applied/no-op, khác 0 khi lỗi.
  CLI hiển thị code cùng request ID: `OPERATOR_FORBIDDEN` cho operator không
  hợp lệ, `NOT_FOUND` cho target thiếu, `USER_SUSPENDED` nếu grant target
  suspended, `PLATFORM_ADMIN_LIMIT_REACHED` khi grant vượt trần, và
  `LAST_PLATFORM_ADMIN` khi gỡ quyền hoặc suspend admin active cuối. Timeout
  báo `MUTATION_OUTCOME_UNKNOWN` và không retry mù. Khi người vận hành chạy lại,
  lệnh áp dụng vào trạng thái hiện tại; revoke-sessions có thể thu hồi phiên
  mới phát sinh giữa hai lần gọi. Không cần sudo hay `Idempotency-Key` cho CLI.

### Chữ ký Redis Functions

Nạp cùng library `sprinthub`, tăng `LIB_VERSION` từ 2 lên 3, giữ toàn bộ chữ ký
foundation. Mọi key dưới đây có prefix của foundation. Ký hiệu `U(uid)` =
`user:{uid}`, `I(uid)` = `user-sessions:{uid}`, `S(d)` = `session:{d}`,
`E(e)` = `user-email:{e}`, `P` = `platform-admins`, `C` =
`platform-settings`, `A` = `stream:audit`.
`S(ds…)` và `U(as…)` là các slot mở rộng theo danh sách digest/admin ID đã
sắp tăng dần và bỏ trùng, truyền trong ARGS dưới dạng JSON array. Slot lặp do
target hoặc actor có mặt trong snapshot giữ đúng thứ tự trong bảng.

| Function | KEYS theo thứ tự | ARGS theo thứ tự |
| --- | --- | --- |
| `sh_register_user` | `C, E(emailDigest), U(uid), users-by-created` | uid, emailDigest, normalizedEmail, displayEmail, passwordHash, displayName |
| `sh_take_auth_rate_limit` | login: `ratelimit:login-ip:{ipHash}, ratelimit:login-acct:{emailDigest}`; register: `ratelimit:register:{ipHash}`; write: `ratelimit:write:{uid}` | scope `login\|register\|write`, ipHash hoặc uid, emailDigest hoặc rỗng |
| `sh_create_session` | `E(emailDigest), U(uid), I(uid), S(newDigest), S(ds…)` | uid, emailDigest, newDigest, publicSessionId, priorDigest hoặc rỗng, sessionDigestsJson |
| `sh_touch_session` | `S(digest), I(uid)` | uid, digest, touchIntervalMs |
| `sh_logout_session` | `S(digest), U(uid), I(uid)` | uid, digest |
| `sh_logout_all_sessions` | `S(digest), U(uid), I(uid), S(ds…)` | uid, digest, sessionDigestsJson |
| `sh_update_my_profile` | `S(digest), U(uid), I(uid), idempotency:{uid}:{key}` | uid, digest, expectedVersion, patchJson, idempotencyKey, requestHash |
| `sh_grant_admin` | `P, U(actor), U(target), A, I(target), S(ds…)` | actorId, targetId, osUser, requestId, sessionDigestsJson |
| `sh_revoke_admin`, `sh_suspend_user` | `P, U(actor), U(target), A, I(target), U(as…), S(ds…)` | actorId, targetId, osUser, requestId, adminIdsJson, sessionDigestsJson |
| `sh_reactivate_user` | `P, U(actor), U(target), A, I(target)` | actorId, targetId, osUser, requestId |
| `sh_revoke_sessions` | `P, U(actor), U(target), A, I(target), S(ds…)` | actorId, targetId, osUser, requestId, sessionDigestsJson |
| `sh_set_platform_setting` | `P, U(actor), C, A` | actorId, settingName, value, osUser, requestId |

- **Trước lệnh ghi đầu tiên:** dựng lại và so toàn bộ tên/kiểu key theo
  prefix, ARGS và slot; đọc JSON/HASH thật và đối chiếu identity/owner; kiểm
  quyền (session tự phục vụ, hoặc operator active); kiểm snapshot khi có;
  profile tra idempotency rồi mới kiểm version; kiểm điều kiện nghiệp vụ và
  type, tính trước payload ghi. Lệch tên/snapshot trả `KEYS_MISMATCH` trước
  ghi. Caller đọc lại và thử tối đa hai lần. Key sai kiểu hoặc bản ghi hỏng
  là lỗi nội bộ. Thực hiện ghi gốc + index/audit; lưu idempotency profile ở cuối.
- **Snapshot:** caller đọc danh sách bounded bằng `SMEMBERS`. Function kiểm
  trần trước khi đọc danh sách, đối chiếu danh sách ARGS với SET thật, và chỉ
  đọc từng key đã khai báo. Admin count đọc trạng thái từng user ngay lúc gọi
  dù SET không đổi. Session check đối chiếu owner của mọi HASH còn tồn tại trước
  khi xóa, rồi dọn được cả member đã mất HASH. Function xóa HASH trước index.
  Suspend chuẩn bị sẵn payload cập nhật user, xóa mọi HASH phiên và index
  trước khi đặt disabled. Redis không rollback lệnh đã chạy, nên thứ tự này
  bảo vệ invariant 14 ngay cả nếu lỗi giữa chừng. Login thêm index cho phiên
  mới trước khi tạo HASH + TTL và dọn phiên cũ theo plan đã kiểm.
  Nếu đã biết chưa gửi, trả lỗi foundation. Nếu mất reply, không gọi lại mù.
- **Commit và reply:** dùng chuỗi JSON `{"ok":true,"data":…,"seq":null}` và
  `{"ok":false,"code":…,"params":…}`. Mở rộng decoder của foundation cho
  success `seq:null` ở nhóm Function global, giữ số nguyên cho wrapper
  workspace. Register mới hoặc trùng đều trả cùng
  data chấp nhận; đóng đăng ký trả code 403 cả khi email đã có. Limiter tăng
  counter ngay cả khi deny (side effect quota chủ ý), không ghi user/session.
  Admin success có `changed` boolean. Session tạo xong trả projection
  Profile và caller mới gửi cookie. Profile hash chuẩn hóa bằng tên thao tác,
  đích, payload gồm expectedVersion và clientMutationId; không gồm digest
  phiên hay requestId. Bản ghi chỉ chứa projection và TTL 24 giờ.
- **Phân quyền app:** `sh-app` dùng read command, `FCALL` và command/key
  cần cho Lua của auth. Thu hẹp key pattern của runtime tới các họ key app cần,
  loại `platform-admins` và `stream:audit`; mọi Function CLI đều khai hai key
  đó. Runtime được đọc setting thông qua Function register. Kiểm thử credential
  `sh-app` gọi register được nhưng không gọi Function admin. HTTP chỉ ghi qua
  repository, không dùng `sh-maint`. ACL thu hẹp lệnh và key, còn ranh giới
  ghi qua Function do code và test giữ.

## Risks / Trade-offs

- Session SET giữ member TTL đã hết cho tới lượt login hoặc thu hồi; trần và
  pipeline giới hạn chi phí. Dùng SLOWLOG ngưỡng 0 với 32 phiên và 16 admin
  để nghiệm thu max < 5 ms. Mỗi nhánh từ chối nghiệp vụ giữ nguyên dữ liệu,
  ngoại trừ cập nhật quota có chủ đích. So snapshot ở biên FCALL khi kiểm
  nhánh từ chối. Touch chạy ngoài ba batch đồng bộ của board.
- AOF lưu cả ghi dở do Lua lỗi. Nếu suspend lỗi trước khi đặt disabled,
  một phần phiên có thể đã bị thu hồi, user vẫn active. Nếu đã đặt disabled
  thì mọi HASH phiên đã bị xóa. Verifier offline kiểm chéo user/email/created
  index, phiên còn hiệu lực và admin active.
  Test tiêm lỗi kiểm báo cáo đúng; không tự apply repair trong change này.
- Login retry sau mất reply có thể để lại phiên còn TTL. Người dùng kiểm qua
  GET sessions và thu hồi bằng logout-all; register trùng vẫn phản hồi chung,
  và CLI check trạng thái hiện tại khi retry.
- Bộ đếm account cố ý áp cả email chưa có; quota có thể bị dùng hết từ IP
  khác. Form CSRF dùng same-origin, yêu cầu kiểm đường rewrite trước khi
  tích hợp FE. Rate header là hợp đồng SprintHub dựa theo draft, không phụ
  thuộc draft tự cập nhật.
