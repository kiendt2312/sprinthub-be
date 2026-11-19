# HTTP contract auth và hồ sơ

Các path dưới đây có prefix `/api/v1`. Kế thừa header `X-Request-Id`,
`Server-Timing`, `Cache-Control: no-store` và error envelope từ
contract của change `scaffold-be-foundation`. Response JSON thành
công có `requestId` khớp header. `204` không có body. Routes không có workspace
`seq`. `openapi.json` sinh từ NestJS sẽ bổ sung paths, schema, cookie security
và header vào contract hiện có.

## Request chung

- JSON body dùng `Content-Type: application/json`. Body ngoài schema, sai kiểu
  hoặc malformed trả `400 VALIDATION_FAILED`. Route ghi có schema body rỗng
  thì chấp nhận request không body hoặc JSON `{}`.
- Mọi route cần `X-CSRF-Protection: 1`. Với POST/PATCH, `Origin` phải có
  và khớp origin app đã cấu hình. Với GET, browser cùng origin có thể bỏ
  `Origin`. Nếu gửi `Origin`, giá trị phải khớp. Vi phạm trả
  `403 CSRF_INVALID` trước khi kiểm session hoặc gia hạn TTL.
- Cookie auth `__Host-sh_session` là chuỗi opaque base64url 32 byte.
  `Set-Cookie` khi login gồm `HttpOnly; Secure; SameSite=Lax; Path=/;
  Max-Age=2592000`, không có `Domain`. Logout/logout-all xóa cookie với
  thuộc tính tương đương và `Max-Age=0`. TTL phía server là 7 ngày trượt
  tính từ lượt xác thực gần nhất, tối đa 30 ngày từ lúc tạo.
- Bốn route `/auth/*` không yêu cầu `Idempotency-Key` hoặc
  `X-Client-Mutation-Id`. Cookie session là cơ chế xác thực của các route cần
  session. Guest không truyền token qua header hoặc JSON.

## Kiểu dữ liệu

| Tên | Schema |
| --- | --- |
| `Profile` | `{id:string,email:string,displayName:string,avatarUrl:string\|null,locale:"en"\|"vi",version:integer}`; version ≥ 1 |
| `Session` | `{id:string,createdAtMs:integer,lastSeenAtMs:integer,expiresAtMs:integer,absoluteExpiresAtMs:integer,current:boolean}`; timestamp UTC epoch ms, ID công khai `ses_<ULID>` |
| `email` | Email ASCII hợp lệ, tối đa 254 ký tự sau trim. Trim và lowercase để tra cứu. Dạng hiển thị giữ chữ hoa/thường |
| `password` | Chuỗi 15–128 Unicode code point; giữ nguyên khi hash, kể cả khoảng trắng |
| `displayName` | Chuỗi 1–80 Unicode code point sau trim |
| `avatarUrl` | URL tuyệt đối HTTPS tối đa 2.048 ký tự, không có credentials trong URL; `null` để xóa |
| `locale` | `en` hoặc `vi` |

`Profile` và `Session` là allow-list. BE không trả password hash, session
digest, raw token trong JSON, role, metadata suspend, Redis key hay dữ liệu
phiên của user khác.

## Routes

| Method và path | Request | Response thành công | Lỗi nghiệp vụ |
| --- | --- | --- | --- |
| `POST /auth/register` | `{email,password,displayName}` bắt buộc | `202 {"status":"accepted","requestId":"…"}` cho cả email mới và email đã có. Không đặt cookie. Profile mới có locale `en` và avatar `null` | `403 REGISTRATION_DISABLED`, `429 RATE_LIMITED` |
| `POST /auth/login` | `{email,password}` bắt buộc | `200 {"data":Profile,"requestId":"…"}` + `Set-Cookie` mới. Retry thành công có thể tạo thêm phiên | `401 INVALID_CREDENTIALS`, `401 USER_SUSPENDED`, `409 SESSION_LIMIT_REACHED`, `429 RATE_LIMITED` |
| `POST /auth/logout` | Body rỗng; cookie nếu có | `204` + xóa cookie, chỉ thu hồi phiên gửi lên. Cookie thiếu/sai/hết hạn/thu hồi cùng response | Lỗi chung |
| `POST /auth/logout-all` | Body rỗng; cookie nếu có | `204` + xóa cookie. Cookie hợp lệ thu hồi mọi phiên của user, gồm phiên hiện tại; cookie thiếu/sai/hết hạn/thu hồi chỉ xóa cookie | Lỗi chung |
| `GET /users/me` | Cookie hợp lệ, không body/query | `200 {"data":Profile,"requestId":"…"}` | `401 SESSION_INVALID` |
| `PATCH /users/me` | Cookie hợp lệ, `Idempotency-Key`, `X-Client-Mutation-Id`; body gồm `expectedVersion` và ít nhất một trong `displayName,avatarUrl,locale` | `200 {"data":Profile,"requestId":"…"}` | `401 SESSION_INVALID`, `409 USER_VERSION_CONFLICT`, `422 IDEMPOTENCY_KEY_REUSED`, `429 RATE_LIMITED` |
| `GET /users/me/sessions` | Cookie hợp lệ, không body/query | `200 {"data":[Session,…],"requestId":"…"}`; tối đa 32 phiên chưa hết hạn, mới nhất trước, đồng thời điểm thì ID tăng dần | `401 SESSION_INVALID` |

`expectedVersion` là số nguyên dương an toàn trong JavaScript, lấy từ Profile
gần nhất. `Idempotency-Key` là 1–128 ký tự thuộc `[A-Za-z0-9._-]` và
`X-Client-Mutation-Id` là ULID chuẩn. Thiếu hoặc sai header bắt buộc trả 400.
Field hồ sơ vắng mặt giữ giá trị. Cùng key, cùng payload đã chuẩn hóa và cùng
mutation ID trong 24 giờ trả Profile đã lưu kể cả khi version hiện tại đã đổi,
nếu cookie vẫn hợp lệ và chưa vượt rate limit. Cùng key, khác dữ liệu đã chuẩn
hóa hoặc mutation ID trả 422. Profile version có thể tăng khi login ghi
`lastLoginAt` hoặc CLI thay trạng thái user. Client nhận 409 tải lại Profile.

## Mã lỗi và rate headers

Mỗi lỗi dùng `{"error":{"code":"…","params":{…}},"requestId":"…"}`. Mã trong
bảng route cộng với 400 theo schema, 403 CSRF theo yêu cầu chung, 500 khi lỗi nội bộ và
503 lỗi Redis theo contract nền. `MUTATION_OUTCOME_UNKNOWN` chỉ dùng khi backend
có thể đã gửi một lệnh ghi, kể cả lệnh touch session ở route GET. Auth tự
áp dụng ngữ nghĩa retry ở bảng route. PATCH dùng lại cùng key và mutation ID
sau khi nhận 503 không rõ kết quả.

| Status | Code | Params | Điều kiện |
| --- | --- | --- | --- |
| `401` | `INVALID_CREDENTIALS` | `{}` | Email không có tài khoản hoặc mật khẩu sai |
| `401` | `USER_SUSPENDED` | `{}` | Credential đúng nhưng Function tạo phiên thấy tài khoản suspended |
| `401` | `SESSION_INVALID` | `{}` | Cookie thiếu, sai, hết hạn, đã thu hồi hoặc không còn hợp lệ |
| `403` | `REGISTRATION_DISABLED` | `{}` | Đăng ký tắt tại thời điểm Function chạy |
| `403` | `CSRF_INVALID` | `{}` | Origin hoặc CSRF header không đạt yêu cầu chung |
| `409` | `SESSION_LIMIT_REACHED` | `{limit:32}` | Tạo thêm phiên vượt trần của user |
| `409` | `USER_VERSION_CONFLICT` | `{currentVersion:integer}` | PATCH mới với version không khớp |
| `422` | `IDEMPOTENCY_KEY_REUSED` | `{}` | Dùng lại key của PATCH với payload khác |
| `429` | `RATE_LIMITED` | `{}` | Vượt quota IP, tài khoản hoặc ghi hồ sơ |

`429` gửi `Retry-After` bằng số giây nguyên dương cho đến khi mọi cửa sổ đang
chặn hết hạn. `RateLimit` liệt kê policy đang chặn với quota còn lại và thời gian
còn lại làm tròn lên, ví dụ `"login-ip";r=0;t=42, "login-acct";r=0;t=49`.
Tên policy là `login-ip`, `login-acct`, `register` hoặc `write`.
Giới hạn tương ứng là 20/15 phút/IP, 5/15 phút/tài khoản, 3/giờ/IP và
120/phút/user. Ví dụ trên gửi `Retry-After: 49`. Không đưa digest của IP hay
email vào response. FE tra bản dịch bằng code và params.
