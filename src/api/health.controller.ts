import { Controller, Get, Req } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { ApiError, ErrorEnvelopeDto } from '../platform/http/errors.js';
import type { ApiRequest } from '../platform/http/request.js';
import { RedisStore } from '../redis/client.js';

class HealthDto {
  @ApiProperty({ enum: ['ok'] }) status!: 'ok';
  @ApiProperty({ type: String }) requestId!: string;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly redis: RedisStore) {}

  @Get('live')
  @ApiOkResponse({ type: HealthDto })
  live(@Req() request: ApiRequest): HealthDto {
    return { status: 'ok', requestId: request.requestId };
  }

  @Get('ready')
  @ApiOkResponse({ type: HealthDto })
  @ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto })
  async ready(@Req() request: ApiRequest) {
    if (!await this.redis.ready()) throw new ApiError(503, 'SERVICE_NOT_READY');
    return this.live(request);
  }
}
