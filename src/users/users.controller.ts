import { Body, Controller, Get, Headers, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiConflictResponse, ApiCookieAuth, ApiForbiddenResponse, ApiHeader, ApiInternalServerErrorResponse, ApiOkResponse, ApiServiceUnavailableResponse, ApiTags, ApiTooManyRequestsResponse, ApiUnauthorizedResponse, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import { ErrorEnvelopeDto } from '../platform/http/errors.js';
import type { ApiRequest } from '../platform/http/request.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard } from '../auth/auth.guard.js';
import { PatchProfileDto } from '../auth/auth.dto.js';
import { ProfileEnvelopeDto, SessionsEnvelopeDto } from '../auth/auth.openapi.js';
import { UsersService } from './users.service.js';
import { NoQueryGuard } from './no-query.guard.js';

@ApiTags('users')
@ApiCookieAuth('session')
@Controller('api/v1/users/me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @UseGuards(NoQueryGuard, SessionGuard)
  @ApiOkResponse({ type: ProfileEnvelopeDto })
  @ApiBadRequestResponse({ type: ErrorEnvelopeDto })
  @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto, description: 'SESSION_INVALID' })
  @ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto })
  @ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto, description: 'REDIS_UNAVAILABLE' })
  async getMe(@Req() request: ApiRequest & AuthenticatedRequest) {
    return { data: await this.users.getProfile(request.auth!), requestId: request.requestId };
  }

  @Patch()
  @UseGuards(CsrfGuard, SessionGuard)
  @ApiOkResponse({ type: ProfileEnvelopeDto })
  @ApiHeader({ name: 'Origin', required: true })
  @ApiHeader({ name: 'X-CSRF-Protection', required: true, schema: { type: 'string', enum: ['1'] } })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._-]+$' } })
  @ApiHeader({ name: 'X-Client-Mutation-Id', required: true, schema: { type: 'string', pattern: '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiBadRequestResponse({ type: ErrorEnvelopeDto })
  @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto, description: 'SESSION_INVALID' })
  @ApiForbiddenResponse({ type: ErrorEnvelopeDto, description: 'CSRF_INVALID' })
  @ApiConflictResponse({ type: ErrorEnvelopeDto, description: 'USER_VERSION_CONFLICT' })
  @ApiUnprocessableEntityResponse({ type: ErrorEnvelopeDto, description: 'IDEMPOTENCY_KEY_REUSED' })
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto, headers: {
    'Retry-After': { description: 'Seconds until retry is allowed', schema: { type: 'integer' } },
    RateLimit: { description: 'Blocked write policy', schema: { type: 'string' } },
  } })
  @ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto })
  @ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto, description: 'REDIS_UNAVAILABLE or MUTATION_OUTCOME_UNKNOWN' })
  async patchMe(
    @Body() body: PatchProfileDto,
    @Req() request: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey: string,
    @Headers('x-client-mutation-id') mutationId: string,
  ) {
    const data = await this.users.updateProfile(request.auth!, body, idempotencyKey, mutationId);
    return { data, requestId: request.requestId };
  }

  @Get('sessions')
  @UseGuards(NoQueryGuard, SessionGuard)
  @ApiOkResponse({ type: SessionsEnvelopeDto })
  @ApiBadRequestResponse({ type: ErrorEnvelopeDto })
  @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto, description: 'SESSION_INVALID' })
  @ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto })
  @ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto, description: 'REDIS_UNAVAILABLE' })
  async sessions(@Req() request: ApiRequest & AuthenticatedRequest) {
    return { data: await this.users.getSessions(request.auth!), requestId: request.requestId };
  }
}
