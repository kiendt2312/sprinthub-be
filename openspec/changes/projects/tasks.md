## 1. Project trong Redis

- [ ] 1.1 Thêm Function tạo/sửa/archive/unarchive, index workspace và unique key, preflight và outbox v5 (invariant 2, 8, 9, 13, 17).
- [ ] 1.2 Chạy test Redis thật cho race key/version, đổi key trước/sau khi cấp số, archive/replay, KEYS sai và quyền (invariant 2, 8, 9, 13, 17).

## 2. HTTP project

- [ ] 2.1 Thêm module, route, DTO, pagination, map lỗi và sinh OpenAPI (invariant 2, 8, 9, 17).
- [ ] 2.2 Chạy HTTP integration Redis thật cho tất cả route, tenant/role, hai chế độ list, cursor, archive và unarchive (invariant 2, 8, 9, 17).

## 3. Nghiệm thu

- [ ] 3.1 Chạy kịch bản archive → permalink → remove/unassign → unarchive trên Redis thật, xác minh replay, index và SLOWLOG (invariant 2, 3, 6, 8, 9, 13, 17).
