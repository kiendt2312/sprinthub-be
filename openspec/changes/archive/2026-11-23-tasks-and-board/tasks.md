## 1. Redis Function và tương thích

- [x] 1.1 Nâng LIB_VERSION 4 → 5, cập nhật readiness, giữ chữ ký cũ, nối workspace/backlog vào create và workspace vào move (invariant 2, 3, 4, 5, 6, 8, 9, 10, 13, 17).
- [x] 1.2 Viết update, assign và xóa mềm với snapshot key, replay, quyền, version, outbox và index (invariant 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 17).
- [x] 1.3 Chạy Redis thật cho T-004, race assign/remove, T-005, T-006, T-008, T-009, T-012, full cột, xóa mềm, 100 lần move/assign song song và spike suite/kịch bản cho chữ ký cũ (invariant 2–10, 13, 17).

## 2. HTTP task và board

- [x] 2.1 Thêm module, route, DTO, repository, retry KEYS_MISMATCH và ghi OpenAPI (invariant 2, 3, 7, 8, 17).
- [x] 2.2 Thực hiện list/filter tuple và board ba batch với quota, kiểm membership và bỏ card stale (invariant 2, 4, 5, 7).
- [x] 2.3 Chạy Redis thật cho T-003, T-005/006/008/009, fixture 250 task và T-021, kiểm OpenAPI FE (invariant 2, 4, 5, 7, 8, 17).

## 3. Verifier và nghiệm thu

- [x] 3.1 Bổ sung verifier hai chiều backlog, permalink và index active; scope fixture cho test T-020 (invariant 2, 4, 5, 6, 7, 9, 10).
- [x] 3.2 Hạ batch unassign mặc định xuống 32 sau phép đo trên Redis thật. Kiểm lại fencing, resume và SLOWLOG trên task Markdown dài (invariant 3, 6, 8, 13, 18).
- [x] 3.3 Chạy Redis thật qua Make, lint/typecheck, ba lượt suite cùng volume, demo P0 đầy đủ, restart/verifier, SLOWLOG và OpenSpec strict (invariant 2–10, 13, 17).
