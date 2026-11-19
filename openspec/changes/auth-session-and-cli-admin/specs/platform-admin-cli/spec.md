# Platform Admin CLI

## Purpose

Cho phép operator quản trị account trên host qua SSH, giữ ít nhất một Platform
Admin active và có audit Redis cho mỗi thay đổi có hiệu lực.

## ADDED Requirements

### Requirement: Danh tính CLI do host xác định

CLI SHALL chạy trên VM qua SSH với `sh-maint`. CLI SHALL tra OS user hiệu dụng
trong file root-owned `/etc/sprinthub/cli-operators.json`, hoặc dùng ánh xạ
`.env.local` trong chế độ local, và SHALL không nhận `--as`. Function SHALL
kiểm operator là admin active trước lệnh ghi, ngoại trừ grant bootstrap.

#### Scenario: Operator bị revoke hoặc suspend
- **WHEN** operator còn trong file host nhưng bị revoke hoặc suspend trong Redis trước FCALL
- **THEN** CLI thoát khác 0, không thay đổi target hay audit nghiệp vụ

#### Scenario: Danh tính bootstrap đã được ánh xạ
- **WHEN** SET admin rỗng và operator đã đăng ký, còn active, chạy grant cho chính ID trong mapping
- **THEN** user đó trở thành Platform Admin và audit ghi đúng actor CLI cùng OS user

#### Scenario: Grant khác ID khi bootstrap
- **WHEN** SET admin rỗng và operator được map tới A gửi grant cho B, hoặc file thiếu mapping
- **THEN** CLI thoát khác 0, SET rỗng và không có audit thành công

### Requirement: Không mất admin active cuối

Function revoke và suspend SHALL kiểm admin active còn lại trong cùng call
với ghi. SET sau bootstrap SHALL còn ít nhất một user active. Admin đã
suspend không được tính. Grant SHALL giữ SET trong trần 16 thành viên.

#### Scenario: Hai admin revoke nhau đồng thời
- **WHEN** A và B là hai admin active cuối và gọi revoke nhau từ hai kết nối
- **THEN** đúng một lệnh có hiệu lực, lệnh sau bị từ chối do operator hết quyền, và còn một admin active

#### Scenario: Hai admin tự suspend đồng thời
- **WHEN** A và B là hai admin active cuối và mỗi người suspend chính mình từ kết nối riêng
- **THEN** đúng một lệnh có hiệu lực; lệnh thua nhận `LAST_PLATFORM_ADMIN` và user thua vẫn active

#### Scenario: SET còn admin đã suspend
- **WHEN** admin active cuối tự revoke hoặc suspend trong khi SET vẫn có thành viên suspended
- **THEN** Function trả `LAST_PLATFORM_ADMIN`, trạng thái user, SET và audit không đổi

### Requirement: Admin quản lý trạng thái tài khoản và session

CLI SHALL hỗ trợ grant, revoke, suspend, reactivate và revoke-sessions.
Suspend SHALL đặt disabledAt, thu hồi mọi phiên và chặn lần login kế tiếp.
Grant/revoke thay đổi quyền SHALL thu hồi các token của target; reactivate cho
phép login mới và SHALL không phục hồi token cũ.

#### Scenario: Suspend user có hai thiết bị rồi reactivate
- **WHEN** operator suspend user đang login hai thiết bị rồi reactivate
- **THEN** cả hai cookie cũ nhận `401 SESSION_INVALID` kể cả sau reactivate; login trước reactivate nhận `401 USER_SUSPENDED`, login mới sau reactivate thành công

#### Scenario: Thu hồi phiên khi đổi quyền
- **WHEN** operator grant hoặc revoke quyền của user đang có phiên
- **THEN** SET đổi, các cookie cũ bị vô hiệu và user có thể nhận token mới khi login nếu vẫn active

#### Scenario: Chạy lại thao tác đã áp dụng
- **WHEN** suspend user đã suspended hoặc revoke-sessions của user có index phiên rỗng được gọi lại
- **THEN** CLI thành công dạng no-op, không đổi version hay thêm audit nghiệp vụ

### Requirement: Setting registration được Function thực thi

Operator active SHALL đổi được `registrationEnabled` qua CLI
`registration on|off`. Function register SHALL đọc setting trong Redis
trước khi quyết định tạo tài khoản.

#### Scenario: Off rồi on cùng một triển khai đang chạy
- **WHEN** operator tắt registration, thử đăng ký email mới, rồi bật và thử lại
- **THEN** lần đầu nhận `403 REGISTRATION_DISABLED`, lần sau nhận 202 và tạo đúng một tài khoản

#### Scenario: Register đồng thời với lệnh tắt đăng ký
- **WHEN** registration đang bật và đăng ký một email mới chạy đồng thời với CLI tắt đăng ký trên kết nối riêng
- **THEN** nếu Function register chạy trước thì tạo đúng một tài khoản và trả 202; nếu Function tắt chạy trước thì register trả `403 REGISTRATION_DISABLED` và không ghi user/index

### Requirement: Audit đi cùng thay đổi có hiệu lực

Function CLI SHALL ghi một entry audit cùng thao tác có hiệu lực với actor
`cli:<adminId>`, OS user, action, target/setting, requestId và thời điểm.
Lệnh CLI SHALL không đòi sudo hoặc Idempotency-Key, và SHALL không tự gửi lại
sau timeout không rõ kết quả.

#### Scenario: Audit cho suspend đã commit
- **WHEN** suspend thành công trên user active
- **THEN** cùng lần gọi ghi chính xác một entry `stream:audit` có actor, OS user, target và requestId đúng

#### Scenario: Audit key sai kiểu
- **WHEN** `stream:audit` có kiểu Redis không hợp lệ trước một thay đổi
- **THEN** Function báo lỗi nội bộ trước lệnh ghi đầu tiên, user, phiên và quyền không đổi
