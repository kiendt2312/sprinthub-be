## MODIFIED Requirements

### Requirement: Fencing và unassign theo đúng tenant

Function SHALL kiểm lease và epoch mới nhất, kiểm user vắng khỏi
membership và mỗi task thuộc workspace đúng, còn active và còn gán cho user.
Worker SHALL gửi tối đa 32 task mỗi batch theo cấu hình mặc định.
`UNASSIGN_BATCH_SIZE` SHALL chấp nhận số nguyên từ 1 đến 100. Function SHALL
từ chối batch vượt 100 task. Mỗi batch SHALL lưu tiến độ, đồng bộ assigned
index, version, seq và sự kiện.

#### Scenario: Remove trước hoặc sau assignment (T-007)
- **WHEN** tạo task gán user sau remove, hoặc task đã được gán từ trước
- **THEN** create bị từ chối hoặc worker dọn assignment tương ứng, giữ task tenant khác nguyên vẹn

#### Scenario: Epoch cũ và user được thêm lại (T-010)
- **WHEN** lease mới đã cấp epoch khác, hoặc user được thêm lại trước batch
- **THEN** batch zombie bị từ chối, và batch hợp lệ không gỡ assignment của member đã trở lại

#### Scenario: Restart ở giữa các batch
- **WHEN** job có nhiều ứng viên hơn kích thước batch đã cấu hình và worker dừng sau một batch thành công
- **THEN** job tiếp tục đến hết và không tăng version lần thứ hai cho task đã dọn

#### Scenario: Tranh lease và lịch phục hồi
- **WHEN** hai worker claim cùng job hoặc lease hết hạn sau crash
- **THEN** chỉ một lease hợp lệ tại một thời điểm, job đến hạn xuất hiện lại và job đã xong rời lịch
