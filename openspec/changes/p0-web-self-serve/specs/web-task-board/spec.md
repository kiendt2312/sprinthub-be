# Spec Delta

## ADDED Requirements

### Requirement: Đăng ký tài khoản từ web
Web SHALL cung cấp form đăng ký từ màn đăng nhập. Sau khi API chấp nhận yêu cầu, web SHALL đưa người dùng về màn đăng nhập, điền sẵn email, hiển thị thông báo trung tính và yêu cầu nhập mật khẩu để đăng nhập.

#### Scenario: API chấp nhận yêu cầu đăng ký
- **WHEN** người dùng gửi form và API trả phản hồi chấp nhận cho email mới hoặc email đã tồn tại
- **THEN** web hiển thị cùng thông báo và cùng hướng đi tới đăng nhập trong cả hai trường hợp
- **AND** trường mật khẩu đăng nhập để trống

#### Scenario: Đăng ký bị từ chối
- **WHEN** API từ chối yêu cầu vì dữ liệu, giới hạn tần suất hoặc đăng ký đang tắt
- **THEN** web giữ người dùng trên form và hiển thị lỗi tương ứng

### Requirement: Tạo workspace từ danh sách workspace
Web SHALL cung cấp thao tác tạo workspace trên danh sách của phiên hiện hành, kể cả khi danh sách trống. Form SHALL gợi ý slug từ tên, cho chỉnh slug và mở workspace mới sau khi tạo thành công.

#### Scenario: Tạo workspace đầu tiên
- **GIVEN** người dùng đã đăng nhập và danh sách workspace trống
- **WHEN** người dùng nhập tên, chấp nhận hoặc chỉnh slug gợi ý và lưu thành công
- **THEN** web mở trang của workspace vừa tạo

#### Scenario: Slug đã chỉnh hoặc bị trùng
- **WHEN** người dùng đã sửa slug rồi đổi tên workspace
- **THEN** web giữ slug đã nhập
- **AND** nếu API báo slug trùng, web chỉ rõ trường slug và giữ nội dung form để sửa

### Requirement: Tạo project từ trang workspace
Web SHALL cung cấp thao tác tạo project trên trang workspace cho Owner và Admin, kể cả khi chưa có project. Form SHALL gợi ý mã project từ tên, cho chỉnh mã và mở board của project sau khi tạo thành công.

#### Scenario: Tạo project đầu tiên
- **GIVEN** người dùng là Owner hoặc Admin của workspace
- **WHEN** người dùng nhập tên, chấp nhận hoặc chỉnh mã gợi ý và lưu thành công
- **THEN** web mở board của project vừa tạo

#### Scenario: Mã đã chỉnh hoặc bị trùng
- **WHEN** người dùng đã sửa mã project rồi đổi tên
- **THEN** web giữ mã đã nhập
- **AND** nếu API báo mã trùng, web chỉ rõ trường mã và giữ nội dung form để sửa

### Requirement: Tạo task bằng tiêu đề ngay trên Kanban
Web SHALL cho thành viên tạo task trên board của project đang hoạt động với tiêu đề là trường duy nhất. Khi tạo thành công, web SHALL đóng form và giữ người dùng trên board.

#### Scenario: Task xuất hiện trong To do
- **WHEN** API xác nhận đã tạo task và board tải thành công
- **THEN** web hiển thị task với issue key do API cấp trong cột To do theo thứ tự API và đưa tiêu điểm tới thẻ
- **AND** task vẫn mở được từ thẻ và hiện đúng cột sau khi tải lại

#### Scenario: Đọc board thất bại sau khi đã lưu
- **WHEN** API xác nhận đã tạo task nhưng lần tải board kế tiếp thất bại
- **THEN** web báo task đã được tạo và cho phép thử tải board
- **AND** thao tác thử lại chỉ đọc board

### Requirement: Thử lại thao tác tạo khi kết quả chưa rõ
Khi form tạo workspace, project hoặc task còn mở và kết quả ghi chưa rõ, web SHALL giữ nguyên dữ liệu đã gửi và mã nhận diện thao tác để người dùng chủ động thử lại.

#### Scenario: Mất phản hồi hoặc API báo kết quả chưa rõ
- **WHEN** người dùng chọn thử lại từ form sau khi mất phản hồi hoặc nhận lỗi kết quả chưa rõ
- **THEN** web gửi lại đúng dữ liệu, `Idempotency-Key` và `X-Client-Mutation-Id` của lần gửi trước
- **AND** web chỉ gửi lại sau thao tác của người dùng

#### Scenario: Tải lại trang khi kết quả chưa rõ
- **WHEN** người dùng tải lại hoặc rời trang khi form đang giữ thao tác chưa rõ kết quả
- **THEN** web tải danh sách hoặc board từ API khi người dùng mở lại trang
- **AND** lần gửi đang chờ và bản nháp chỉ tồn tại trong form của phiên trang trước
