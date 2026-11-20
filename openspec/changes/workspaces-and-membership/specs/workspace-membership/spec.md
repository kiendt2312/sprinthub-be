# Workspace và membership

## Purpose

Workspace là ranh giới phân quyền và dữ liệu của một team SprintHub.

## ADDED Requirements

### Requirement: Khởi tạo workspace và các index nguyên tử

Workspace creation SHALL tạo Workspace JSON, OWNER, reverse index, slug
unique và created index trong cùng Function. Mutation SHALL phát một event
và lưu response idempotency.

#### Scenario: Replay và tranh slug
- **WHEN** hai kết nối gửi cùng yêu cầu tạo, hoặc nhiều actor tranh một slug
- **THEN** cùng thao tác nhận cùng workspace/seq, slug chỉ có một chủ và lần tạo khác nhận 409

#### Scenario: Dùng lại key cho payload khác
- **WHEN** actor dùng lại key thành công với nội dung đã chuẩn hóa khác
- **THEN** trả 422 và không ghi thêm workspace, index hoặc event

### Requirement: Đọc workspace và danh sách theo membership hiện hành

API SHALL xác thực session và dùng membership hiện tại trong Redis để trả dữ liệu.
Danh sách SHALL hỗ trợ cursor với giới hạn tối đa 100 phần tử.

#### Scenario: Phân trang và tenant isolation
- **WHEN** member đọc hai trang workspace hoặc member, và actor ngoài workspace đọc chi tiết hoặc member list
- **THEN** các trang đi đúng thứ tự cursor, không lặp ID, và request ngoài tenant nhận 404

### Requirement: Sửa workspace có quyền và version

Function SHALL kiểm role, version và slug unique trước khi đổi workspace.
Tên slug cũ SHALL được giải phóng cùng mutation.

#### Scenario: Sửa và tranh version
- **WHEN** Admin sửa slug/name và hai kết nối sửa với cùng version
- **THEN** một request mới thành công, request còn lại trả 409 với currentVersion, và slug index khớp document

#### Scenario: Từ chối thiếu quyền hoặc slug đã có chủ
- **WHEN** Member sửa setting hoặc Admin chọn slug đã thuộc workspace khác
- **THEN** lần lượt trả 403 và 409, giữ nguyên các key nghiệp vụ

#### Scenario: Mutation mới gặp workspace suspended
- **WHEN** workspace đã suspend và actor có quyền gửi mutation mới hoặc replay thao tác thành công trước đó
- **THEN** mutation mới nhận 423, còn replay giữ nguyên dữ liệu và seq đã lưu

### Requirement: Quản lý member và giữ đúng một Owner

Function SHALL thêm user đã đăng ký theo ID/email với role MEMBER; chỉ Owner
được đổi role, chuyển Owner hoặc gỡ Admin. Owner SHALL được giữ cho tới khi
transfer nguyên tử hoàn tất.

#### Scenario: Thêm bằng ID hoặc email, gỡ member và replay
- **WHEN** Admin thêm user đã đăng ký, gỡ MEMBER và retry cùng key
- **THEN** membership và reverse index đồng bộ, có một event gỡ và một entry audit, và request kế tiếp của user đã gỡ nhận 404

#### Scenario: Đổi role và chuyển Owner đồng thời
- **WHEN** Owner đổi role của member hoặc hai kết nối chuyển Owner sang hai member khác nhau
- **THEN** quyền mới có hiệu lực ở request kế tiếp, chỉ một transfer mới thành công, HASH còn đúng một OWNER khớp ownerId

#### Scenario: Bảo vệ Owner và cho phép rời workspace
- **WHEN** actor cố gỡ/đổi role Owner, Owner cố rời, hoặc member khác tự rời
- **THEN** Owner vẫn giữ quyền, request rời của member xóa membership và tạo event dọn assignee

### Requirement: Tuân thủ bảo vệ và envelope HTTP

Mutation workspace SHALL kiểm CSRF, quota, header, DTO allow-list và trả
mã lỗi dịch được. Replay SHALL yêu cầu quyền tenant hiện hành.

#### Scenario: Request không hợp lệ và replay sau revoke
- **WHEN** request thiếu header, sai DTO, vượt quota hoặc actor ngoài tenant replay mutation cũ
- **THEN** trả 400, 403, 429 hoặc 404 tương ứng theo contract, không ghi dữ liệu workspace mới
