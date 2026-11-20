import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBadRequestResponse, ApiBody, ApiConflictResponse, ApiCookieAuth, ApiForbiddenResponse, ApiHeader, ApiInternalServerErrorResponse, ApiNoContentResponse, ApiOkResponse, ApiSecurity, ApiServiceUnavailableResponse, ApiTags, ApiTooManyRequestsResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ErrorEnvelopeDto } from '../platform/http/errors.js';
import type { ApiRequest } from '../platform/http/request.js';
import { AuthService } from './auth.service.js';
import { CsrfGuard } from './csrf.guard.js';
import { LoginDto, RegisterDto } from './auth.dto.js';
import { ProfileEnvelopeDto, RegisterAcceptedDto, clearedSessionCookie, issuedSessionCookie } from './auth.openapi.js';
import { EmptyBodyGuard } from './empty-body.guard.js';

@ApiTags('auth')
@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: RegisterAcceptedDto })
  @ApiHeader({ name: 'Origin', required: true })
  @ApiHeader({ name: 'X-CSRF-Protection', required: true, schema: { type: 'string', enum: ['1'] } })
  @ApiBadRequestResponse({ type: ErrorEnvelopeDto })
  @ApiForbiddenResponse({ type: ErrorEnvelopeDto, description: 'CSRF_INVALID or REGISTRATION_DISABLED' })
  @ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto })
  @ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto, description: 'REDIS_UNAVAILABLE or MUTATION_OUTCOME_UNKNOWN' })
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto, headers: {
    'Retry-After': { description: 'Seconds until retry is allowed', schema: { type: 'integer' } },
    RateLimit: { description: 'Blocked rate limit policies', schema: { type: 'string' } },
  } })
  async register(@Body() body: RegisterDto, @Req() request: ApiRequest) {
    const result = await this.auth.register(body, request);
    return { status: result.status, requestId: request.requestId };
  }

  @Post('login')
  @UseGuards(CsrfGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ProfileEnvelopeDto, headers: issuedSessionCookie })
  @ApiHeader({ name: 'Origin', required: true })
  @ApiHeader({ name: 'X-CSRF-Protection', required: true, schema: { type: 'string', enum: ['1'] } })
  @ApiBadRequestResponse({ type: ErrorEnvelopeDto })
  @ApiForbiddenResponse({ type: ErrorEnvelopeDto, description: 'CSRF_INVALID' })
  @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto, description: 'INVALID_CREDENTIALS or USER_SUSPENDED' })
  @ApiConflictResponse({ type: ErrorEnvelopeDto, description: 'SESSION_LIMIT_REACHED' })
  @ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto })
  @ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto, description: 'REDIS_UNAVAILABLE or MUTATION_OUTCOME_UNKNOWN' })
  @ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto, headers: {
    'Retry-After': { description: 'Seconds until retry is allowed', schema: { type: 'integer' } },
    RateLimit: { description: 'Blocked rate limit policies', schema: { type: 'string' } },
  } })
  async login(@Body() body: LoginDto, @Req() request: ApiRequest, @Res({ passthrough: true }) response: Response) {
    const data = await this.auth.login(body, request, response);
    return { data, requestId: request.requestId };
  }

  @Post('logout')
  @UseGuards(CsrfGuard, EmptyBodyGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ headers: clearedSessionCookie })
  @ApiHeader({ name: 'Origin', required: true })
  @ApiHeader({ name: 'X-CSRF-Protection', required: true, schema: { type: 'string', enum: ['1'] } })
  @ApiSecurity({})
  @ApiCookieAuth('session')
  @ApiForbiddenResponse({ type: ErrorEnvelopeDto })
  @ApiBadRequestResponse({ type: ErrorEnvelopeDto })
  @ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto, description: 'REDIS_UNAVAILABLE or MUTATION_OUTCOME_UNKNOWN' })
  @ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto })
  @ApiBody({ required: false, schema: { type: 'object', additionalProperties: false } })
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    // Logout is intentionally anonymous for stale or missing cookies.
    await this.auth.logout(request, response);
  }

  @Post('logout-all')
  @UseGuards(CsrfGuard, EmptyBodyGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ headers: clearedSessionCookie })
  @ApiHeader({ name: 'Origin', required: true })
  @ApiHeader({ name: 'X-CSRF-Protection', required: true, schema: { type: 'string', enum: ['1'] } })
  @ApiSecurity({})
  @ApiCookieAuth('session')
  @ApiForbiddenResponse({ type: ErrorEnvelopeDto })
  @ApiBody({ required: false, schema: { type: 'object', additionalProperties: false } })
  @ApiBadRequestResponse({ type: ErrorEnvelopeDto })
  @ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto, description: 'REDIS_UNAVAILABLE or MUTATION_OUTCOME_UNKNOWN' })
  @ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto })
  async logoutAll(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    await this.auth.logoutAll(request, response);
  }
}
