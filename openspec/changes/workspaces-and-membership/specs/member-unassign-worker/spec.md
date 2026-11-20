# Worker dọn assignee P0

## Purpose

Dọn task của member đã rời workspace hoặc bị gỡ, có thể tiếp tục sau crash.

## ADDED Requirements

### Requirement: Persist job trước khi xác nhận event

Worker SHALL tạo group unassign khi bootstrap, ACK event không liên quan,
và tạo job bằng JSON.SET NX theo eventId trước khi ACK MEMBER_REMOVED.
Worker SHALL lấy lại pending qua XAUTOCLAIM và tìm lại job chưa hoàn tất
sau restart bằng lịch phục hồi bền, cùng Function với thao tác ghi job.

#### Scenario: Crash trước persist và sau persist hoặc ACK
- **WHEN** worker dừng trước JSON.SET, sau JSON.SET trước ACK, hoặc sau ACK trước batch
- **THEN** khi khởi động lại job duy nhất chạy xong và mỗi task chỉ thay đổi một lần

### Requirement: Fencing và unassign theo đúng tenant

Function SHALL kiểm lease và epoch mới nhất, kiểm user vắng khỏi
membership và mỗi task thuộc workspace đúng, còn active và còn gán cho user.
Worker SHALL gửi tối đa 50 task mỗi batch theo cấu hình mặc định.
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

### Requirement: DLQ có dedupe và trim giữ event cần xử lý

Worker SHALL đưa event thất bại lần thứ tư vào DLQ một lần và ACK sau đó.
Trim SHALL dùng MINID gần đúng với ngưỡng 7 ngày và ACKED.

#### Scenario: Lỗi lặp, giao lại và retention
- **WHEN** event lỗi được giao lại sau khi đã ghi DLQ, hoặc worker trim khi còn entry chưa ACK
- **THEN** chỉ có một bản DLQ và trim giữ entry pending hoặc chưa được các group ACK
