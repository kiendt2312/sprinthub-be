## Purpose

Lưu task của SprintHub trong Redis với issue key duy nhất, thứ tự cột ổn định chỉ nằm
trong ZSET, và mọi thay đổi nhiều key đi qua Redis Function kiểm tra điều kiện trước
lệnh ghi đầu tiên.

## ADDED Requirements

### Requirement: Issue key duy nhất theo project
Hệ thống SHALL cấp cho mỗi task mới một số thứ tự tăng dần theo project và key dạng
`{PROJECT_KEY}-{n}`; key SHALL được lưu trong HASH `workspace-task-keys:{wsId}` trỏ
tới `taskId`; không hai task nào có cùng key và số không được tái sử dụng.

#### Scenario: Tạo task song song
- **WHEN** 50 yêu cầu tạo task cho cùng một project, với 50 `taskId` và 50 `Idempotency-Key` khác nhau, chạy đồng thời
- **THEN** cả 50 thành công với 50 số thứ tự khác nhau, `project-task-seq` bằng 50, mỗi field trong `workspace-task-keys` trỏ đúng task của nó và verifier báo sạch

### Requirement: Tạo task kiểm tra quyền và dữ liệu trong Function
`sh_create_task` SHALL kiểm tra, trước lệnh ghi đầu tiên: actor là member của
workspace, project tồn tại, cùng workspace và chưa archive, `taskId` chưa tồn tại, và
assignee (nếu có) là member tại thời điểm Function chạy. Mọi nhánh từ chối SHALL
không thay đổi bất kỳ key nào.

#### Scenario: Actor không thuộc workspace
- **WHEN** user không có trong `workspace-members` gọi tạo task
- **THEN** Function trả `NOT_FOUND` và snapshot mọi key của workspace không đổi

#### Scenario: Project đã archive
- **WHEN** member tạo task trong project có `archivedAt`
- **THEN** Function trả `PROJECT_ARCHIVED` và không ghi gì

#### Scenario: Assignee đã bị xóa trước khi tạo
- **WHEN** `sh_remove_member` xóa user X, sau đó member khác tạo task gán cho X
- **THEN** Function trả `ASSIGNEE_NOT_MEMBER`, không có task mới, `project-task-seq` và `workspace-seq` không đổi

#### Scenario: Assignee bị xóa sau khi tạo
- **WHEN** task gán cho X được tạo thành công, sau đó `sh_remove_member` xóa X
- **THEN** task vẫn giữ `assigneeId` = X (worker unassign nằm ngoài spike), và lần tạo task tiếp theo gán cho X bị từ chối với `ASSIGNEE_NOT_MEMBER`

#### Scenario: Create và remove chạy xen kẽ
- **WHEN** 100 cặp create-gán-cho-X và remove-X chạy đồng thời trên 100 workspace riêng
- **THEN** ở mỗi workspace, nếu có task gán cho X thì sự kiện tạo task có `seq` nhỏ hơn sự kiện `MEMBER_REMOVED`; không có task nào gán cho X được tạo sau khi X bị xóa

### Requirement: Idempotency trong Function
Mutation SHALL nhận `Idempotency-Key`; bản ghi `idempotency:{actorId}:{key}` là STRING
chứa `{requestHash, response}`, TTL 24 giờ, chỉ được ghi ở cuối đường thành công
trong cùng Function. Function SHALL kiểm tra membership của actor trước khi trả lại
response đã lưu.

#### Scenario: Retry cùng key, cùng payload
- **WHEN** client gửi lại yêu cầu tạo task với cùng `Idempotency-Key` và cùng payload sau khi lần đầu đã thành công
- **THEN** Function trả đúng response lần đầu; chỉ có 1 task, `project-task-seq`, `workspace-seq` và số entry trong `stream:domain-events` chỉ tăng một lần

#### Scenario: Mất response rồi retry
- **WHEN** caller bỏ qua response của lần gọi đầu (mô phỏng timeout) rồi gọi lại với cùng key và payload
- **THEN** kết quả giống kịch bản retry: 1 task, 1 lần tăng seq, 1 event

#### Scenario: Cùng key khác payload
- **WHEN** client dùng lại một `Idempotency-Key` với payload khác
- **THEN** Function trả `IDEMPOTENCY_KEY_REUSED` và không ghi gì

#### Scenario: Actor bị xóa rồi retry
- **WHEN** actor tạo task thành công, bị xóa khỏi workspace, rồi retry với cùng key
- **THEN** Function trả `NOT_FOUND`, không trả lại response đã lưu

### Requirement: Di chuyển task có kiểm soát version và vị trí
`sh_move_task` SHALL kiểm tra trước lệnh ghi đầu tiên: actor là member của
`task.workspaceId`, task tồn tại và chưa xóa, project chưa archive, `task.status`
bằng cột nguồn caller truyền vào, `expectedVersion` khớp (hoặc `clientMutationId`
bằng `lastClientMutationId`), chuyển trạng thái nằm trong bảng cho phép, và task neo
có score trong board đích. Mỗi lần di chuyển thành công SHALL tăng `version` đúng 1
và task active SHALL nằm trong đúng một ZSET board khớp `status`.

#### Scenario: Hai client di chuyển cùng version
- **WHEN** hai yêu cầu di chuyển cùng một task từ TODO sang IN_PROGRESS, cùng `expectedVersion`, khác `clientMutationId` và khác `Idempotency-Key`, chạy đồng thời
- **THEN** đúng một yêu cầu thành công, yêu cầu còn lại nhận `TASK_VERSION_CONFLICT` với `currentVersion` mới, `version` tăng đúng 1 và task nằm trong đúng một cột

#### Scenario: Chuyển trạng thái không hợp lệ
- **WHEN** yêu cầu chuyển task từ TODO sang DONE
- **THEN** Function trả `INVALID_STATUS_TRANSITION` và không ghi gì

#### Scenario: Retry mutation của chính mình
- **WHEN** client gửi lại một lần di chuyển có `clientMutationId` trùng `lastClientMutationId` của task nhưng `expectedVersion` cũ
- **THEN** Function trả trạng thái hiện tại với kết quả thành công thay vì `TASK_VERSION_CONFLICT` và không ghi gì

#### Scenario: Actor ngoài workspace hoặc task không còn
- **WHEN** user ngoài workspace di chuyển task, hoặc member di chuyển task không tồn tại hay đã xóa
- **THEN** Function trả `NOT_FOUND` và không ghi gì

#### Scenario: Task neo sai chỗ
- **WHEN** `beforeTaskId` hoặc `afterTaskId` thuộc project khác, nằm ở cột khác cột đích hoặc không tồn tại
- **THEN** Function trả `INVALID_POSITION_ANCHOR` và không ghi gì

### Requirement: Thứ tự cột bằng sparse integer chỉ nằm trong ZSET
Vị trí trong cột SHALL chỉ lưu dưới dạng score nguyên của ZSET `board:{p}:{status}`,
không lưu trong JSON task. Chèn cuối SHALL là `max + 1024`, chèn đầu là `min − 1024`,
chèn giữa `a < b` là `floor((a + b) / 2)` khi `b − a ≥ 2`.

#### Scenario: Chèn đầu, cuối và giữa
- **WHEN** cột có task score 1024 và 3072, lần lượt chèn một task vào cuối, vào đầu và vào giữa hai task đó
- **THEN** score lần lượt là 4096, 0 và 2048, JSON của các task không có trường `position`

### Requirement: Rebalance cột giữ thứ tự và version
Khi `b − a < 2` hoặc vị trí mới vượt `2^50`, Function SHALL đánh số lại cả cột thành
`i × 1024` giữ nguyên thứ tự, không đổi `version` của task nào ngoài task được di
chuyển, và phát một event `BOARD_REBALANCED`. Cột hơn 500 task SHALL nhận
`BOARD_REBALANCE_REQUIRED` trước khi ghi.

#### Scenario: Hết khoảng trống
- **WHEN** cột có hai task kề nhau với score 1024 và 1025, và một task được chèn vào giữa chúng
- **THEN** cột được đánh số lại thành bội của 1024, thứ tự ID khớp thứ tự mong đợi (task mới nằm giữa hai task neo), task được di chuyển tăng `version` đúng 1, các task khác giữ nguyên `version`, và có đúng một event `BOARD_REBALANCED`

#### Scenario: Chèn lặp tới khi phải rebalance
- **WHEN** liên tục chèn task mới vào giữa cùng hai task neo cho tới khi rebalance xảy ra ít nhất một lần
- **THEN** sau mỗi lần chèn, thứ tự ZSET khớp danh sách thứ tự mong đợi tính ở phía client và mọi score là số nguyên

#### Scenario: Cột quá lớn
- **WHEN** cần rebalance cột có 501 task
- **THEN** Function trả `BOARD_REBALANCE_REQUIRED` và không ghi gì

### Requirement: Lỗi giữa Function không để lại dữ liệu sai mà không bị phát hiện
Function SHALL đọc và kiểm tra hết trước lệnh ghi đầu tiên. Khi lỗi runtime xảy ra sau
lệnh ghi đầu tiên (chỉ có thể là bug), verifier SHALL phát hiện được phần ghi dở.

#### Scenario: Lỗi trước khi ghi
- **WHEN** Function gặp key sai kiểu (ví dụ `project-task-seq` là HASH) hoặc field issue key đã tồn tại
- **THEN** Function trả lỗi và snapshot JSON, index, counter và bản ghi idempotency của workspace không đổi

#### Scenario: Lỗi tiêm sau khi ghi
- **WHEN** chạy bản Function có lỗi tiêm ngay sau `JSON.SET task` trên một workspace riêng
- **THEN** verifier báo task đó ở mục thiếu index, và không có bản ghi idempotency nào được lưu

### Requirement: Verifier index hai chiều
Hệ thống SHALL có verifier offline so JSON task gốc với `project-tasks`, các ZSET board
và `workspace-task-keys` theo cả hai chiều, báo các mục missing, orphan, duplicate và
wrong-pointer.

#### Scenario: Index bị làm hỏng có chủ đích
- **WHEN** trên dữ liệu đứng yên, một task bị xóa khỏi ZSET board, một task bị xóa khỏi cả `project-tasks` và board, một task nằm ở hai cột, một ID trong board không có JSON, và một field `workspace-task-keys` trỏ sai task
- **THEN** báo cáo liệt kê đúng từng task ở mục missing, duplicate, orphan và wrong-pointer tương ứng, không thiếu, không thừa

### Requirement: Dữ liệu bền qua restart và crash process
Dữ liệu, library Function và bản ghi idempotency còn hạn SHALL còn nguyên sau khi
Redis restart. Với `appendfsync always`, mọi ghi đã ACK SHALL còn sau `kill -9`; với
`everysec`, số ghi đã ACK bị mất SHALL được đo và báo cáo.

#### Scenario: Restart thường
- **WHEN** `docker restart` Redis sau khi có dữ liệu seed và đã chạy các kịch bản
- **THEN** `FUNCTION LIST` còn library `sprinthub`, verifier báo sạch, thứ tự cột, `workspace-seq` và bản ghi idempotency còn hạn không đổi

#### Scenario: Crash process khi đang ghi
- **WHEN** client ghi liên tục và ghi log mọi `taskId` đã nhận ACK, rồi Redis bị `kill -9` và khởi động lại trên cùng volume, chạy lần lượt với `always` và `everysec`
- **THEN** với `always` mọi `taskId` đã ACK đều tồn tại; với `everysec` số `taskId` đã ACK bị mất được ghi vào `REPORT.md`; trong cả hai mode verifier báo sạch (hiệu ứng của một Function được ghi vào AOF như một khối, nên không có task ghi dở)
