# HTTP contract nền BE

`openapi.json` ở root được sinh từ NestJS trong lúc triển khai. Health nằm ở
root. Route nghiệp vụ ở `/api/v1` theo từng change. Cả hai probe dùng `GET` và
truy cập được khi không có session. Request không có tham số hay body.

| Route | Điều kiện | Status | JSON body |
| --- | --- | --- | --- |
| `GET /health/live` | Process nhận và xử lý được HTTP, kể cả Redis đang ngắt | `200` | `{"status":"ok","requestId":"req_01..."}` |
| `GET /health/ready` | Redis đáp ứng trong deadline và `sh_lib_version` đúng version của app | `200` | `{"status":"ok","requestId":"req_01..."}` |
| `GET /health/ready` | Redis không đáp ứng hoặc library thiếu/sai version | `503` | Envelope với `SERVICE_NOT_READY`, `params: {}` |

Mọi response do API xử lý, gồm lỗi và `204`, có các header sau.

| Header | Giá trị |
| --- | --- |
| `X-Request-Id` | ID mới do server tạo dạng `req_<ULID>`; trùng `requestId` trong body khi có body |
| `Cache-Control` | `no-store` |
| `Server-Timing` | Metric `app;dur=<ms>` tính từ lúc backend tiếp nhận đến trước khi gửi response |

Mọi lỗi có content type `application/json` và body dạng sau.

```json
{
  "error": { "code": "SERVICE_NOT_READY", "params": {} },
  "requestId": "req_01JDC0ZP1AQAA1VNYQRPRGQ8S4"
}
```

`error.code` là string ổn định để FE tra bản dịch. `params` luôn là object.
Các capability nghiệp vụ bổ sung mã và schema params trong contract của mình.
Chi tiết debug chỉ xuất hiện trong log đã redact, tra bằng `requestId`.

| Status | Code | Params | Điều kiện |
| --- | --- | --- | --- |
| `400` | `VALIDATION_FAILED` | `{}` | JSON sai hoặc DTO ngoài allow-list/không hợp lệ |
| `404` | `NOT_FOUND` | `{}` | Route không có |
| `500` | `INTERNAL_ERROR` | `{}` | Lỗi nội bộ bất ngờ |
| `503` | `SERVICE_NOT_READY` | `{}` | Readiness không đạt |
| `503` | `REDIS_UNAVAILABLE` | `{}` | Redis không phục vụ được, đọc hết hạn hoặc Redis từ chối ghi vì OOM |
| `503` | `MUTATION_OUTCOME_UNKNOWN` | `{}` | Mutation có thể đã tới Redis nhưng backend chưa có reply. BE chỉ thử lại khi có kết quả xác nhận chưa ghi; client retry mutation nghiệp vụ với cùng `Idempotency-Key` |

Business codes từ các change sau được map rõ ràng. `KEYS_MISMATCH` dùng nội bộ.
Response công khai không chứa stack trace, Redis key, credential hay chi tiết
version của health dependency.
