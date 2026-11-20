# Tasks

## 1. Workspace và membership trong Redis

- [x] 1.1 Dùng v4 và giữ chữ ký cũ. Tạo/sửa workspace, reverse và page indexes, slug và created index, outbox/replay (invariant 1, 8, 13, 16, 17).
- [x] 1.2 Thêm/đổi role/chuyển Owner/gỡ/rời workspace kèm audit, kiểm tenant và version trong Function (invariant 1, 8, 13, 17).
- [x] 1.3 Chạy test Redis thật cho replay/tranh chấp, KEYS sai, lỗi trước ghi, suspend/replay, index và verifier (invariant 1, 8, 13, 16, 17).

## 2. HTTP workspace

- [x] 2.1 Module, guard, DTO, pagination/key snapshot, mapping lỗi và OpenAPI theo contract (invariant 1, 16, 17).
- [x] 2.2 Chạy HTTP integration với Redis thật cho RBAC, tenant isolation, đọc sau gỡ, headers/quota/replay và sinh type FE (invariant 1, 17).

## 3. Worker

- [x] 3.1 Bootstrap group, ACK theo thứ tự persist, reclaim, DLQ dedupe và trim ACKED với ACL riêng (invariant 3, 6).
- [x] 3.2 Lịch job bền qua ZSET, resume job và Lua batch có fencing, cập nhật JSON/index/outbox và cursor (invariant 3, 6, 8, 13, 18).
- [x] 3.3 Chạy test Redis thật cho crash/replay và lịch bền, tranh claim, job zombie, T-007/T-010, nhiều batch, đúng tenant, rejoin, DLQ và trim (invariant 3, 6, 8, 13, 18).

## 4. Nghiệm thu

- [x] 4.1 Chạy Redis thật qua Make, lint/typecheck/unit/integration, smoke HTTP và worker, verifier, đo SLOWLOG, spike regressions và OpenSpec strict (invariant 1, 3, 6, 8, 13, 16, 17, 18).
