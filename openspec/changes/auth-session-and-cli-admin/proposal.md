# Auth session và CLI Platform Admin

## Why

P0 cần xác thực người dùng, thu hồi phiên có hiệu lực ngay và quản trị tài khoản
qua SSH trước khi có console. Thay đổi này hoàn thành phần BE của US-01, US-02,
US-10 (CLI) và US-22 (locale).

## What Changes

- Thêm đăng ký Argon2id với phản hồi chung khi trùng email, đăng nhập với cookie
  session opaque, logout/logout-all và danh sách phiên. Bổ sung kiểm tra CSRF,
  giới hạn login theo IP và tài khoản, giới hạn register theo IP.
- Thêm `GET/PATCH /users/me` để đọc hồ sơ và lưu displayName, avatarUrl, locale.
  BE trả mã lỗi và tham số để FE dịch EN/VI.
- Thêm CLI Platform Admin qua SSH dùng `sh-maint`: grant, revoke, suspend,
  reactivate, revoke-sessions và registration on/off. Lấy operator từ ánh xạ
  tin cậy, kiểm quyền trong Redis và ghi audit cùng mutation.
- Bổ sung Function tương thích ngược trong library `sprinthub`, tăng
  `LIB_VERSION` và cập nhật OpenAPI. Kiểm thử T-001, T-002, T-015 và T-016
  phần session trên Redis thật.
- Console, sudo, đổi mật khẩu, maintenance mode và đóng SSE thuộc P1.
  Catalog bản dịch, chọn locale cho khách và UI thuộc repo FE.

## Capabilities

### New Capabilities

- `auth-session` — đăng ký, xác thực, bảo vệ và thu hồi phiên, hồ sơ cá nhân.
- `platform-admin-cli` — danh tính operator, bootstrap, quản trị tài khoản và audit.

### Modified Capabilities

## Impact

- **Phụ thuộc `scaffold-be-foundation`**. Triển khai sau khi có các entrypoint,
  hợp đồng HTTP, kết nối Redis, ACL, loader và CI của change đó.
- Thêm module `auth`, `users`, CLI `scripts/admin/`, Function trong
  `redis/functions/sprinthub.lua` và routes vào `openapi.json`. Library do BE sở hữu.
- Các route dùng prefix `/api/v1`. Bốn route `/auth/*` và CLI tự xử lý retry theo
  ngữ nghĩa riêng. PATCH hồ sơ áp quy ước mutation nghiệp vụ của thiết kế v1.7.
