# Workspace và membership P0

## Why

US-03, US-04 và US-21 cần workspace và quyền theo tenant trước khi mở API
project/task. Gỡ membership còn cần một đường xử lý bền để dọn assignee.

## What Changes

- Tạo, xem, liệt kê và sửa workspace; quản lý thành viên có tài khoản, đổi role,
  chuyển Owner và rời workspace.
- Thu hồi quyền ngay khi gỡ member. Worker lưu job trước ACK, tiếp tục khi
  khởi động lại và dọn assignee theo batch có fencing.
- Thêm contract HTTP và OpenAPI. Nâng library `sprinthub` lên v4, giữ chữ ký
  đã có. Phạm vi này dừng ở workspace, membership và worker P0.

## Capabilities

### New Capabilities

- `workspace-membership` quản lý workspace, RBAC và membership.
- `member-unassign-worker` tiếp nhận event và dọn assignee có thể phục hồi.

## Impact

API NestJS, Redis Functions, ACL của API/worker, consumer group `unassign`,
OpenAPI cho FE và integration trên Redis 8.10.3. Task test dùng
`sh_create_task` hiện có. Invite email, project/task API, SSE, notification
và console admin thuộc change sau.
