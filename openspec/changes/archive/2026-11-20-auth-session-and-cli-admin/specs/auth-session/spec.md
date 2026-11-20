# Auth session

## Purpose

Xác thực người dùng bằng Redis session có thể thu hồi ngay và cung cấp hồ sơ,
locale cho ứng dụng SprintHub.

## ADDED Requirements

### Requirement: Đăng ký duy nhất với phản hồi chung

Register SHALL dùng Argon2id, chuẩn hóa email và giao cho Redis Function kiểm
unique qua `user-email` cùng trạng thái registration. Tạo user và index trong
cùng Function. Email đã có SHALL trả cùng status và dữ liệu như email mới,
không thay tài khoản và không cấp session.

#### Scenario: Đăng ký cùng email đồng thời
- **WHEN** hai request đăng ký `USER@example.com` và `user@example.com` chạy trên hai kết nối
- **THEN** cả hai trả 202 accepted, Redis có một user JSON chứa Argon2id, một mapping email, một member trong users-by-created và không có session

#### Scenario: Registration đã tắt
- **WHEN** admin tắt registration trước khi Function xử lý request cho email mới hoặc đã có
- **THEN** API trả `403 REGISTRATION_DISABLED`; user JSON và index đăng ký không đổi

### Requirement: Login cấp phiên opaque

Login SHALL xác minh mật khẩu rồi tạo token ngẫu nhiên 256-bit mới trong cookie
HttpOnly/Secure/Lax. Redis SHALL dùng digest SHA-256, và Function SHALL kiểm
user thực và `disabledAt` trước khi tạo phiên. User thiếu hoặc mật khẩu sai
SHALL nhận chung `401 INVALID_CREDENTIALS`.

#### Scenario: Login đúng mật khẩu
- **WHEN** user active đăng nhập thành công
- **THEN** response 200 có cookie mới, HASH ở key session SHA-256 và SET index liên quan; raw token không xuất hiện trong JSON hoặc dữ liệu Redis

#### Scenario: Sai credential ở email có hoặc không có tài khoản
- **WHEN** request dùng mật khẩu sai cho tài khoản hiện có hoặc email chưa đăng ký
- **THEN** cả hai nhận `401 INVALID_CREDENTIALS` và không tạo phiên

#### Scenario: Login cạnh tranh với suspend
- **WHEN** login đúng mật khẩu chạy đồng thời với suspend cùng một user
- **THEN** nếu suspend commit trước thì login nhận `401 USER_SUSPENDED`; nếu login commit trước thì suspend xóa phiên vừa tạo, cookie đó nhận `401 SESSION_INVALID` ở request kế tiếp

#### Scenario: Còn đủ 32 phiên
- **WHEN** user có 32 phiên còn hạn và đăng nhập không kèm cookie cũ của mình
- **THEN** login nhận `409 SESSION_LIMIT_REACHED` và không có phiên mới; login thay phiên hiện tại của cùng user vẫn thành công và vô hiệu cookie cũ

### Requirement: Phiên trượt có giới hạn tuyệt đối

Guard SHALL xác thực trong một batch từ `userId`, `expiresAtMs` và
`absoluteExpiresAtMs` của HASH phiên. Guard SHALL không gọi FCALL hay đọc
`disabledAt`. Cookie không hợp lệ SHALL nhận `401 SESSION_INVALID`.
BE SHALL chỉ gia hạn ngoài đường găng nếu `lastSeenAtMs` cũ hơn ngưỡng
cấu hình mặc định 10 phút, tối đa tới ngày 30. Touch SHALL kiểm lại owner,
index và thời hạn, và chỉ ghi log khi lỗi.

#### Scenario: Guard xác thực trong một batch
- **WHEN** request dùng cookie hợp lệ và quota có key đã xác định trước khi tra phiên
- **THEN** trace đồng bộ của guard chỉ có một pipeline với HGETALL và INCR, không có FCALL hoặc đọc JSON user

#### Scenario: Touch theo ngưỡng 10 phút
- **WHEN** hai lượt request dùng phiên hợp lệ, một lượt có lastSeenAtMs chưa quá ngưỡng và một lượt có lastSeenAtMs đã quá ngưỡng
- **THEN** lượt đầu giữ nguyên phiên; lượt sau trả response dù touch còn chờ, rồi touch thành công gia hạn tới tối đa 7 ngày từ lúc touch

#### Scenario: Gia hạn sát giới hạn tuyệt đối
- **WHEN** phiên hợp lệ ở ngày 29 đã quá ngưỡng touch và được dùng trên route bảo vệ
- **THEN** Redis chỉ gia hạn tới ngày 30; request sau deadline nhận `401 SESSION_INVALID`

#### Scenario: Touch đã lên lịch gặp phiên thu hồi
- **WHEN** suspend xóa HASH phiên sau khi touch đã được lên lịch nhưng trước khi Function touch chạy
- **THEN** touch trả no-op và HASH phiên vẫn vắng mặt

#### Scenario: Redis lỗi khi gia hạn ở nền
- **WHEN** request hợp lệ đã gửi response và Function touch gặp lỗi Redis
- **THEN** response giữ kết quả của request và lỗi touch được ghi log theo requestId

#### Scenario: Dùng cookie cũ ngay sau suspend
- **WHEN** CLI suspend đã commit và client dùng cookie cũ ở request bảo vệ kế tiếp
- **THEN** guard nhận HASH trống và trả `401 SESSION_INVALID` ngay trong đường xác thực một batch

#### Scenario: Không hoạt động bảy ngày
- **WHEN** phiên có TTL trượt đã hết và client vẫn gửi cookie
- **THEN** API trả `401 SESSION_INVALID` và không tạo lại HASH phiên

### Requirement: Logout và logout-all thu hồi phiên

Logout SHALL xóa phiên của cookie hiện tại. Logout-all với cookie hợp lệ SHALL
xóa mọi phiên của user trong một Function. Hai route SHALL trả 204 và xóa
cookie nếu cookie hết hạn, không có hoặc đã bị thu hồi.

#### Scenario: Logout một trong hai thiết bị
- **WHEN** thiết bị A logout khi A và B cùng login
- **THEN** A nhận 204, cookie cũ của A nhận 401 ở route bảo vệ và B vẫn vào được

#### Scenario: Logout-all rồi lặp lại
- **WHEN** A logout-all khi còn phiên B rồi gửi lại cùng cookie cũ
- **THEN** cả hai request trả 204, cookie A và B đều nhận `401 SESSION_INVALID` ở route bảo vệ, phiên của user khác giữ nguyên

### Requirement: CSRF bảo vệ HTTP mutation

POST/PATCH/DELETE SHALL yêu cầu `X-CSRF-Protection: 1` và `Origin` khớp
cấu hình, kể cả login, register và logout. Lỗi SHALL trả `403 CSRF_INVALID`
trước limiter hoặc ghi nghiệp vụ. GET SHALL xác thực mà không yêu cầu CSRF.

#### Scenario: Origin khác hoặc thiếu header
- **WHEN** browser gọi mutation với origin khác hoặc thiếu header CSRF
- **THEN** request nhận 403 và snapshot Redis không đổi

#### Scenario: GET không có header CSRF
- **WHEN** GET profile hoặc sessions gửi cookie hợp lệ mà không gửi header CSRF hay Origin
- **THEN** API trả 200 và xử lý gia hạn phiên theo ngưỡng hoạt động

### Requirement: Quota auth lưu trong Redis

BE SHALL giới hạn login theo IP 20/15 phút và theo tài khoản 5/15 phút, register
3/giờ/IP. Các lần thử login hợp lệ về CSRF và DTO SHALL tính cả thành công
và thất bại. Khi vượt quota SHALL trả 429 với `Retry-After` và `RateLimit`.

#### Scenario: Đổi email để thử từ một IP
- **WHEN** cùng IP thử 50 email khác nhau trong một cửa sổ
- **THEN** từ lần 21 nhận 429 theo quota IP

#### Scenario: Đổi IP khi thử cùng một email
- **WHEN** thử lần thứ 6 cùng email chuẩn hóa từ 6 IP trong một cửa sổ
- **THEN** lần thứ 6 nhận 429 theo quota tài khoản dù còn quota IP

#### Scenario: Quota đăng ký hết và tự mở lại
- **WHEN** cùng IP gửi lần đăng ký thứ 4 trước khi hết cửa sổ
- **THEN** lần thứ 4 nhận 429 kèm header; lần thử hợp lệ sau khi TTL hết bắt đầu cửa sổ mới

### Requirement: Hồ sơ và danh sách phiên chỉ lộ dữ liệu cho phép

`GET /users/me` SHALL trả projection Profile và `GET /users/me/sessions`
SHALL liệt kê phiên còn hiệu lực của chính user với ID công khai và cờ current.
PATCH SHALL chỉ cho phép displayName, avatarUrl và locale `en|vi`, kiểm
`expectedVersion`, giới hạn 120/phút/user và dùng idempotency cho mutation.

#### Scenario: Đổi locale rồi đọc lại hồ sơ
- **WHEN** client có phiên hợp lệ PATCH locale thành `vi` với version và header đúng
- **THEN** PATCH trả Profile với version tăng một, GET sau đó trả `vi` và response không có field nội bộ

#### Scenario: Update song song và replay
- **WHEN** hai PATCH khác payload và khác key cùng version chạy đồng thời, rồi client gửi lại bản thắng nguyên payload và key
- **THEN** một update thành công, một `409 USER_VERSION_CONFLICT` kèm currentVersion; replay trả Profile cũ, không tăng version, cùng key khác payload trả 422

#### Scenario: Chỉ phiên hợp lệ của actor được liệt kê
- **WHEN** user có hai phiên hợp lệ, một member stale trong SET và một user khác đang login
- **THEN** GET sessions chỉ trả hai phiên còn hạn của actor, đánh dấu đúng phiên hiện tại và không có raw token hay digest

#### Scenario: Gửi field ngoài allow-list
- **WHEN** client PATCH field `disabledAt` hoặc gửi locale ngoài `en|vi`
- **THEN** API trả `400 VALIDATION_FAILED` và hồ sơ giữ nguyên

### Requirement: Auth retry theo ngữ nghĩa của từng thao tác

Auth SHALL không ghi cache response theo `Idempotency-Key`. Redis mutation
mất reply SHALL không tự gửi lại. Register dựa vào unique email và login retry
có thể tạo phiên mới, logout xử lý cookie hết hiệu lực như no-op.

#### Scenario: Mất reply sau khi login đã tạo phiên
- **WHEN** Redis commit login nhưng API quá deadline trước khi nhận reply
- **THEN** API trả 503 không đặt cookie, không tự gọi lại, và một lần login mới hợp lệ cấp token mới nếu quota và trần phiên cho phép
