# Công việc triển khai auth session và CLI Platform Admin

Chạy sau `scaffold-be-foundation`. Số invariant theo `docs/design/design.md` v1.7.

## 1. Register và rate limit

- [ ] 1.1 Tạo auth/users module, DTO, CSRF guard, cấu hình origin/trust proxy và secret HMAC IP. Tạo key builder và preflight Lua dùng chung. Thêm `sh_take_auth_rate_limit` với fixed window, map Retry-After/RateLimit và chặn trước Argon2id.
- [ ] 1.2 Thêm chuẩn hóa email và hash Argon2id. Viết `sh_register_user` với kiểm tra registration và email unique trước ghi JSON, mapping và created index. Trả cùng 202 theo contract (invariant 16).
- [ ] 1.3 Nâng library lên version 3, giữ các Function cũ và hỗ trợ decode `seq:null` cho Function global. Bổ sung quyền lệnh/key cần cho auth và test ranh giới runtime/maintenance.
- [ ] 1.4 Kiểm tra trên Redis thật: T-001 đăng ký đồng thời theo email chuẩn hóa, response 202 như nhau, Argon2id, key/index khớp, registration disabled không ghi user/index. T-002 thử 50 email từ một IP, thử 6 IP cùng email, register lần 4 cùng IP và kiểm reset theo TTL. Kiểm CSRF từ chối trước khi đổi counter (invariant 16).

## 2. Login, auth guard và logout

- [ ] 2.1 Thêm lookup email và verify Argon2id/dummy hash. Viết `sh_create_session` khóa theo user thật và index snapshot, kiểm disabledAt, làm sạch digest stale, giới hạn 32 mục, cấp token mới và cập nhật lastLoginAt trong Function (invariant 8, 14).
- [ ] 2.2 Viết `sh_touch_session`, `sh_logout_session`, `sh_logout_all_sessions` và repository. Thực thi TTL trượt/tối đa, guard kiểm lại Redis và logout 204 với cookie cũ. Tách xử lý cookie khỏi dữ liệu lưu/log (invariant 14).
- [ ] 2.3 Kiểm tra trên Redis thật: login đúng/sai, cookie Secure/HttpOnly/Lax, không có raw token trong Redis, TTL 7/30 ngày dùng fixture thời hạn, trần phiên và xoay cookie, logout/logout-all trên hai thiết bị, snapshot lệch từ chối trước ghi. Bỏ reply login để kiểm 503 và số lần gọi, rồi login lại (invariant 8, 14).

## 3. Hồ sơ và danh sách phiên

- [ ] 3.1 Thêm GET/PATCH profile và GET sessions với projection allow-list. PATCH kiểm CSRF/DTO/header, áp limiter ghi; `sh_update_my_profile` kiểm session, idempotency và version trong Function, lưu locale `en|vi` (invariant 8, 14, 17).
- [ ] 3.2 Sinh `openapi.json` từ controller/DTO và map toàn bộ mã lỗi, header, cookie, success/204 theo contract. Xác nhận FE sinh type được từ OpenAPI; catalog và giao diện FE xử lý trong repo FE.
- [ ] 3.3 Kiểm tra trên Redis thật: kiểm GET có cookie nhưng thiếu CSRF header không gia hạn TTL, cập nhật EN/VI, avatar null, từ chối field ngoài allow-list, 429 ghi, hai PATCH cùng version, replay cùng key và khác payload, cookie thu hồi bị từ chối và danh sách không có phiên quá hạn/user khác hay digest (invariant 8, 14, 17).

## 4. CLI admin và nghiệm thu cuối

- [ ] 4.1 Thêm các lệnh grant/revoke/suspend/reactivate/revoke-sessions/registration bằng `sh-maint`, mapping OS user đáng tin, bootstrap grant rõ ràng và exit/output có requestId. Mô tả setup mapping và lệnh trong README (invariant 14, 15).
- [ ] 4.2 Viết sáu Function CLI theo bảng chữ ký. Kiểm role active và bộ KEYS, trần 16 admin, admin active cuối, thu hồi phiên đồng bộ và audit preflight. Kiểm registration off/on có hiệu lực ở Function register (invariant 8, 14, 15, 16).
- [ ] 4.3 Thêm kiểm tra offline hai chiều cho mapping email/created index, owner và index của phiên còn hạn, user disabled và admin active. Thêm fixture sai kiểu và lỗi runtime sau ghi để kiểm report xác định đúng phần lệch (invariant 14, 15, 16).
- [ ] 4.4 Kiểm tra trên Redis thật: T-015 revoke/suspend đồng thời qua kết nối riêng, và T-016 suspend cùng lúc login, hai cookie cũ bị 401 kể cả sau reactivate. Kiểm bootstrap và operator sai quyền, audit actor/OS user/ID, grant/revoke xoay phiên, registration on/off và race với register, no-op không ghi lặp. Chạy ACL với `sh-app` bị chặn gọi Function CLI, verifier và SLOWLOG workload tại hai trần, restart cùng volume, test tương thích library v2, đối chiếu OpenAPI/contract và ghi kết quả (invariant 8, 14, 15, 16, 17).
