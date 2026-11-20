# redis-task-core Specification

## Purpose
Lưu task của SprintHub trong Redis với issue key duy nhất, thứ tự cột ổn định chỉ nằm
trong ZSET, và mọi thay đổi nhiều key đi qua Redis Function kiểm tra tenant, quyền,
idempotency và điều kiện nghiệp vụ trước lệnh ghi đầu tiên.

## Requirements

### Requirement: Reply Function có cấu trúc
Mọi Function ghi SHALL trả một chuỗi JSON: `{"ok":true,"data":…,"seq":…}` khi thành
công hoặc `{"ok":false,"code":…,"params":…}` khi từ chối nghiệp vụ. Lỗi giao thức
Redis SHALL chỉ dùng cho lỗi nội bộ của caller, Function hoặc dữ liệu Redis.

#### Scenario: Conflict mang theo version hiện tại
- **WHEN** move bị từ chối vì `expectedVersion` cũ trong khi task đang ở version 7
- **THEN** caller decode được `code` = `TASK_VERSION_CONFLICT` và `params.currentVersion` = 7

### Requirement: KEYS phải khớp tenant thật
Function SHALL dựng lại tên key từ ARGS và so với KEYS, rồi đọc project hoặc task thật
và đối chiếu workspace và project với ARGS, trước khi kiểm tra quyền hay tra
idempotency. Key idempotency SHALL được dựng lại từ `actorId` và `idempotencyKey` trong
ARGS. Lệch SHALL trả `KEYS_MISMATCH` và không ghi gì.

#### Scenario: Bộ key của workspace khác
- **WHEN** actor là member của workspace A nhưng đã bị gỡ khỏi workspace B, và gọi create cho project thuộc B với `workspace-members` của A cùng `Idempotency-Key` đã dùng thành công ở B trước đó
- **THEN** Function trả `KEYS_MISMATCH` hoặc `NOT_FOUND`, không trả lại response đã lưu và không ghi gì

#### Scenario: Key idempotency của actor khác
- **WHEN** actor A gọi create với KEYS chứa `idempotency:{B}:{key}` mà B đã dùng thành công
- **THEN** Function trả `KEYS_MISMATCH`, không trả lại response của B và không ghi gì

#### Scenario: Cột nguồn đã đổi
- **WHEN** caller gọi move với `from` = TODO trong khi task đã ở IN_PROGRESS
- **THEN** Function trả `KEYS_MISMATCH` trước khi tra idempotency và không ghi gì. Caller đọc lại `from` trước khi thử lại với cùng `Idempotency-Key`

### Requirement: Issue key duy nhất theo project
Hệ thống SHALL cấp cho mỗi task mới số `n = project-task-seq + 1` và key
`{PROJECT_KEY}-{n}` lưu trong HASH `workspace-task-keys:{wsId}` trỏ tới `taskId`; field
SHALL được kiểm tra chưa tồn tại trước lệnh ghi đầu tiên; không hai task nào có cùng
key và số không được tái sử dụng.

#### Scenario: Tạo task song song
- **WHEN** 50 yêu cầu tạo task cho cùng một project, với 50 `taskId` và 50 `Idempotency-Key` khác nhau, chạy đồng thời trên các kết nối riêng
- **THEN** cả 50 thành công với 50 số thứ tự khác nhau, `project-task-seq` bằng 50, mỗi field trong `workspace-task-keys` trỏ đúng task của nó và verifier báo sạch

#### Scenario: Field kế tiếp đã bị chiếm
- **WHEN** `workspace-seq` khác `project-task-seq`, và field `{KEY}-{project-task-seq + 1}` đã có sẵn trong `workspace-task-keys`
- **THEN** Function báo lỗi giao thức Redis trước khi ghi, `project-task-seq` và `workspace-seq` không đổi

### Requirement: Tạo task kiểm tra quyền và dữ liệu trong Function
`sh_create_task` SHALL kiểm tra, trước lệnh ghi đầu tiên: actor là member của
workspace thật của project, project chưa archive, `taskId` chưa tồn tại, và assignee
(nếu có) là member tại thời điểm Function chạy. Mọi nhánh từ chối SHALL không thay đổi
bất kỳ key nào.

#### Scenario: Actor không thuộc workspace
- **WHEN** user không có trong `workspace-members` gọi tạo task
- **THEN** Function trả `NOT_FOUND` và snapshot mọi key của workspace không đổi

#### Scenario: Project đã archive
- **WHEN** member tạo task mới trong project có `archivedAt`
- **THEN** Function trả `PROJECT_ARCHIVED` và không ghi gì

#### Scenario: Caller cấp lại ID task đã tồn tại
- **WHEN** caller gửi lệnh tạo mới với một `Idempotency-Key` khác và `taskId` đã tồn tại
- **THEN** Function báo lỗi giao thức Redis trước khi ghi và snapshot không đổi

#### Scenario: Replay qua thời điểm archive
- **WHEN** tạo task thành công, sau đó project bị archive, rồi client retry cùng `Idempotency-Key` và payload
- **THEN** Function trả đúng response đã lưu, không trả `PROJECT_ARCHIVED` và không ghi gì thêm

#### Scenario: Không gán và có gán
- **WHEN** tạo một task không có assignee (slot `user-assigned:none`) và một task gán cho member X
- **THEN** key `user-assigned:none` không tồn tại, còn `user-assigned:{X}` chứa đúng task thứ hai (invariant 6)

#### Scenario: Assignee đã bị xóa trước khi tạo
- **WHEN** `sh_remove_member` xóa user X, sau đó member khác tạo task gán cho X
- **THEN** Function trả `ASSIGNEE_NOT_MEMBER`, không có task mới, `project-task-seq` và `workspace-seq` không đổi

#### Scenario: Assignee bị xóa sau khi tạo
- **WHEN** task gán cho X được tạo thành công, sau đó `sh_remove_member` xóa X
- **THEN** task vẫn giữ `assigneeId` = X (worker unassign nằm ngoài spike), và lần tạo task tiếp theo gán cho X bị từ chối với `ASSIGNEE_NOT_MEMBER`

#### Scenario: Create và remove chạy xen kẽ
- **WHEN** 100 cặp create-gán-cho-X và remove-X chạy đồng thời, mỗi cặp trên một workspace riêng và hai kết nối riêng
- **THEN** ở mỗi workspace remove thành công đúng một lần với đúng một event `MEMBER_REMOVED`, và create chỉ có một trong hai kết quả: thành công với task và event `TASK_CREATED` có `seq` nhỏ hơn `MEMBER_REMOVED`, hoặc `ASSIGNEE_NOT_MEMBER` mà không có task, issue number, event hay bản ghi idempotency nào

### Requirement: Idempotency trong Function
Mọi mutation SHALL nhận `Idempotency-Key`; đây là cơ chế retry duy nhất. Bản ghi
`idempotency:{actorId}:{key}` là STRING chứa `{requestHash, response}`, TTL 24 giờ, chỉ
được ghi ở cuối đường thành công. Function SHALL tra idempotency sau khi kiểm tra quyền
và trước khi kiểm tra điều kiện nghiệp vụ; `requestHash` SHALL không gồm `from` hay
`nowMs`.

#### Scenario: Retry cùng key, cùng payload
- **WHEN** client gửi lại yêu cầu tạo task với cùng `Idempotency-Key` và cùng payload sau khi lần đầu đã thành công
- **THEN** Function trả đúng response lần đầu; chỉ có 1 task, `project-task-seq`, `workspace-seq` và số entry trong `stream:domain-events` chỉ tăng một lần

#### Scenario: Mất response của move rồi gửi lại nguyên lệnh
- **WHEN** move TODO → IN_PROGRESS thành công nhưng caller bỏ response, rồi gửi lại cùng key và payload; API đọc lại task và truyền `from` = IN_PROGRESS
- **THEN** Function trả đúng response lần đầu, `version`, `workspace-seq` và số event không tăng thêm

#### Scenario: Cùng key khác payload
- **WHEN** client dùng lại một `Idempotency-Key` với payload khác
- **THEN** Function trả `IDEMPOTENCY_KEY_REUSED` và không ghi gì

#### Scenario: Actor bị xóa rồi retry
- **WHEN** actor tạo task thành công, bị xóa khỏi workspace, rồi retry với cùng key
- **THEN** Function trả `NOT_FOUND`, không trả lại response đã lưu

### Requirement: Di chuyển task có kiểm soát version
`sh_move_task` SHALL kiểm tra trước lệnh ghi đầu tiên: task tồn tại và chưa xóa, actor
là member của `task.workspaceId`, project chưa archive, `expectedVersion` khớp và
chuyển trạng thái nằm trong bảng cho phép. Mỗi lần di chuyển thành công SHALL tăng
`version` đúng 1, phát đúng một event và giữ task active trong đúng một ZSET board khớp
`status`.

#### Scenario: Hai client di chuyển cùng version
- **WHEN** hai yêu cầu di chuyển cùng một task từ TODO sang IN_PROGRESS, cùng `expectedVersion`, khác `clientMutationId` và khác `Idempotency-Key`, chạy đồng thời trên hai kết nối
- **THEN** đúng một yêu cầu thành công, yêu cầu còn lại nhận `KEYS_MISMATCH`. Sau khi caller đọc lại `from` và gọi lại với `expectedVersion` cũ, Function trả `TASK_VERSION_CONFLICT` với `params.currentVersion` mới. `version` tăng đúng 1 và task nằm trong đúng một cột

#### Scenario: Chuyển trạng thái không hợp lệ
- **WHEN** yêu cầu chuyển task từ TODO sang DONE
- **THEN** Function trả `INVALID_STATUS_TRANSITION` và không ghi gì

#### Scenario: Actor ngoài workspace hoặc task không còn
- **WHEN** user ngoài workspace di chuyển task, hoặc member di chuyển task không tồn tại hay đã xóa
- **THEN** Function trả `NOT_FOUND` và không ghi gì

### Requirement: Task neo xác định đúng chỗ chèn
Sau khi loại task đang move khỏi cột đích, `afterTaskId` và `beforeTaskId` SHALL khác
nhau, có trong board đích và kề nhau; chỉ `afterTaskId` thì nó SHALL là task cuối cột,
chỉ `beforeTaskId` thì nó SHALL là task đầu cột, không có task neo thì chèn cuối cột.
Sai SHALL trả `INVALID_POSITION_ANCHOR` và không ghi gì.

#### Scenario: Task neo sai chỗ
- **WHEN** task neo thuộc project khác, nằm ở cột khác cột đích, không tồn tại, trùng nhau, trùng task đang move, hoặc hai task neo không kề nhau
- **THEN** Function trả `INVALID_POSITION_ANCHOR` và không ghi gì

#### Scenario: Reorder trong cùng cột
- **WHEN** task thứ nhất trong cột 3 task được move xuống giữa task thứ hai và thứ ba
- **THEN** thứ tự mới là thứ hai, thứ nhất, thứ ba và `version` của task được move tăng 1

### Requirement: Thứ tự cột bằng sparse integer chỉ nằm trong ZSET
Vị trí trong cột SHALL chỉ lưu dưới dạng score nguyên của ZSET `board:{p}:{status}`,
không lưu trong JSON task. Cột rỗng SHALL nhận score 1024, chèn cuối là `max + 1024`,
chèn đầu là `min − 1024`, chèn giữa `a < b` là `floor((a + b) / 2)` khi `b − a ≥ 2`.

#### Scenario: Chèn vào cột rỗng, cuối, đầu và giữa
- **WHEN** chèn task vào cột rỗng, rồi với cột có score 1024 và 3072 lần lượt chèn vào cuối, vào đầu và vào giữa hai task đó
- **THEN** score lần lượt là 1024, 4096, 0 và 2048, và JSON của các task không có trường `position`

### Requirement: Rebalance cột giữ thứ tự trong cùng một mutation
Khi `b − a < 2` hoặc score mới vượt `|2^50|` (kể cả create ở cuối cột), Function SHALL
đánh số lại cả cột thành `i × 1024` giữ nguyên thứ tự rồi chèn, không đổi `version` của
task khác, và vẫn phát đúng một event của thao tác (`TASK_MOVED` khi move, `TASK_CREATED`
khi create) mang `rebalancedColumn`; entry
`board:{p}:{status}` SHALL được ghi vào `workspace-changes` cùng seq.

#### Scenario: Hết khoảng trống
- **WHEN** cột có hai task kề nhau với score 1024 và 1025, và một task được chèn vào giữa chúng
- **THEN** cột được đánh số lại thành bội của 1024, task mới nằm giữa hai task neo, task được move tăng `version` đúng 1, các task khác giữ nguyên `version`, có đúng một event mới với `rebalancedColumn` và `workspace-changes` có entry của cột tại seq đó

#### Scenario: Chèn lặp làm hẹp khoảng
- **WHEN** liên tục chèn task mới ngay dưới task vừa chèn trước đó (task neo trên là task vừa chèn, task neo dưới giữ nguyên) cho tới khi rebalance xảy ra ít nhất một lần
- **THEN** rebalance xảy ra sau tối đa 11 lần chèn kể từ khoảng 1024, và sau mỗi lần chèn thứ tự ZSET khớp danh sách thứ tự mong đợi tính ở phía client, mọi score là số nguyên

#### Scenario: Rebalance cột đầy
- **WHEN** cột có đúng 500 task không còn khoảng trống ở chỗ chèn, và một task trong cột được reorder vào chỗ đó
- **THEN** rebalance chạy ngay trong Function, thứ tự đúng và thời gian chạy được ghi vào số đo

### Requirement: Giới hạn 500 task mỗi cột
Trước lệnh ghi đầu tiên, Function SHALL tính kích thước cột đích sau thao tác: create và
move sang cột khác tính thêm 1 task, reorder trong cùng cột giữ nguyên. Kích thước vượt
500 SHALL trả `COLUMN_FULL` với `params.limit` = 500 và không ghi gì.

#### Scenario: Task thứ 501
- **WHEN** cột TODO có 500 task, rồi tạo task mới hoặc move một task từ cột khác vào TODO
- **THEN** Function trả `COLUMN_FULL` với `params.limit` = 500 và không ghi gì; reorder trong TODO vẫn thành công

#### Scenario: Tranh slot cuối
- **WHEN** cột có 499 task và hai request tạo task vào cột đó chạy đồng thời trên hai kết nối
- **THEN** đúng một request thành công, request còn lại nhận `COLUMN_FULL`, cột có đúng 500 task

### Requirement: Lỗi giữa Function bị phát hiện
Function SHALL đọc và kiểm tra hết trước lệnh ghi đầu tiên. Khi lỗi runtime xảy ra sau
lệnh ghi đầu tiên (chỉ có thể là bug), phần đã ghi SHALL được phát hiện: thiếu index
bởi verifier, thiếu event và bản ghi idempotency bởi assertion của kịch bản.

#### Scenario: Lỗi trước khi ghi
- **WHEN** Function gặp key sai kiểu (ví dụ `project-task-seq` là HASH)
- **THEN** Function trả lỗi và snapshot JSON, index, counter và bản ghi idempotency của workspace không đổi

#### Scenario: Lỗi tiêm sau khi ghi JSON
- **WHEN** chạy bản Function có lỗi tiêm ngay sau `JSON.SET task` trên một workspace riêng
- **THEN** verifier báo task đó thiếu index, không có event `TASK_CREATED` và không có bản ghi idempotency

#### Scenario: Lỗi tiêm sau khi ghi index
- **WHEN** chạy bản Function có lỗi tiêm sau khi đã ghi JSON và mọi index nhưng trước `XADD`
- **THEN** verifier báo sạch, còn assertion của kịch bản phát hiện thiếu event và thiếu bản ghi idempotency

### Requirement: Verifier index hai chiều
Hệ thống SHALL có verifier offline so JSON task gốc với `project-tasks`, các ZSET board
và `workspace-task-keys` theo cả hai chiều, kiểm score là số nguyên trong `|2^50|`, và
báo các mục missing, orphan, duplicate, wrong-pointer và bad-score.

#### Scenario: Index bị làm hỏng có chủ đích
- **WHEN** trên dữ liệu đứng yên, một task bị xóa khỏi ZSET board, một task bị xóa khỏi cả `project-tasks` và board, một task nằm ở hai cột, một ID trong board không có JSON, một field `workspace-task-keys` trỏ sai task và một score là `1.5`
- **THEN** báo cáo liệt kê đúng từng task ở mục missing, duplicate, orphan, wrong-pointer và bad-score tương ứng, không thiếu, không thừa

### Requirement: Dữ liệu bền qua restart và crash process
Dữ liệu, library Function và bản ghi idempotency còn hạn SHALL còn nguyên sau khi
Redis restart. Sau `kill -9`, mỗi task phục hồi từ mutation hợp lệ SHALL có đủ side
effect; với `appendfsync always`, mọi ghi đã ACK SHALL còn; với `everysec`, số ghi đã
ACK bị mất SHALL được đo và báo cáo.

#### Scenario: Restart thường
- **WHEN** `docker restart` Redis sau khi có dữ liệu seed và đã chạy các kịch bản
- **THEN** `FUNCTION LIST` còn library `sprinthub`, verifier báo sạch, thứ tự cột, `workspace-seq` và bản ghi idempotency còn hạn không đổi

#### Scenario: Crash process khi đang ghi
- **WHEN** client tạo task liên tục, ghi log mọi `taskId` đã gửi và đã nhận ACK, rồi Redis bị `kill -9` và khởi động lại trên cùng volume, chạy lần lượt với `always` và `everysec`
- **THEN** mỗi task còn lại có đủ JSON, index, event `TASK_CREATED` và bản ghi idempotency; với `always` mọi `taskId` đã ACK đều còn; với `everysec` số `taskId` đã ACK bị mất và số request đang bay được ghi riêng vào `REPORT.md`

### Requirement: Xóa member idempotent
`sh_remove_member` SHALL nhận `Idempotency-Key` như mọi mutation nghiệp vụ: KEYS gồm
`idempotency:{actorId}:{idempotencyKey}`, tra idempotency sau khi kiểm tra quyền, lưu ở
cuối khi thành công.

#### Scenario: Gửi lại lệnh xóa member
- **WHEN** lệnh xóa user X thành công rồi được gửi lại với cùng `Idempotency-Key` và cùng payload
- **THEN** Function trả đúng response lần đầu; `workspace-seq` và số event `MEMBER_REMOVED` chỉ tăng một lần
