import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBody, ApiConflictResponse, ApiCookieAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiHeader, ApiInternalServerErrorResponse, ApiNotFoundResponse, ApiOkResponse, ApiParam, ApiQuery, ApiResponse, ApiServiceUnavailableResponse, ApiTags, ApiTooManyRequestsResponse, ApiUnauthorizedResponse, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard } from '../auth/auth.guard.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { ErrorEnvelopeDto } from '../platform/http/errors.js';
import type { ApiRequest } from '../platform/http/request.js';
import { NoQueryGuard } from '../users/no-query.guard.js';
import { CreateProjectDto, PatchProjectDto, ProjectQueryDto, ProjectVersionDto } from './project.dto.js';
import { ProjectEnvelopeDto, ProjectListEnvelopeDto } from './project.openapi.js';
import { ProjectService } from './project.service.js';

@ApiTags('projects')
@ApiCookieAuth('session')
@Controller('api/v1')
export class ProjectsController {
  constructor(private readonly projects: ProjectService) {}

  @Post('workspaces/:workspaceId/projects')
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'workspaceId', schema: { type: 'string', pattern: '^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiBody({ type: CreateProjectDto }) @ApiCreatedResponse({ type: ProjectEnvelopeDto }) @MutationHeaders() @ApiErrors()
  async create(@Param('workspaceId') wid: string, @Body() body: CreateProjectDto, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.projects.create(req.auth!, wid, body, req.requestId, idem, mutationId), requestId: req.requestId };
  }

  @Get('workspaces/:workspaceId/projects')
  @UseGuards(SessionGuard)
  @ApiParam({ name: 'workspaceId', schema: { type: 'string', pattern: '^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiQuery({ name: 'archived', required: false, schema: { type: 'string', enum: ['true', 'false'], default: 'false' } })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100, example: 50 })
  @ApiQuery({ name: 'cursor', required: false, type: String, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' })
  @ApiOkResponse({ type: ProjectListEnvelopeDto }) @ReadErrors()
  async list(@Param('workspaceId') wid: string, @Query() query: ProjectQueryDto, @Req() req: ApiRequest & AuthenticatedRequest) {
    return { ...await this.projects.list(req.auth!, wid, query.limit ?? 50, query.archived === 'true', query.cursor), requestId: req.requestId };
  }

  @Get('projects/:projectId')
  @UseGuards(SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'projectId', schema: { type: 'string', pattern: '^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiOkResponse({ type: ProjectEnvelopeDto }) @ReadErrors()
  async get(@Param('projectId') pid: string, @Req() req: ApiRequest & AuthenticatedRequest) {
    return { ...await this.projects.get(req.auth!, pid), requestId: req.requestId };
  }

  @Patch('projects/:projectId')
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'projectId', schema: { type: 'string', pattern: '^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiBody({ type: PatchProjectDto }) @ApiOkResponse({ type: ProjectEnvelopeDto }) @MutationHeaders() @ApiErrors()
  async update(@Param('projectId') pid: string, @Body() body: PatchProjectDto, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.projects.update(req.auth!, pid, body, req.requestId, idem, mutationId), requestId: req.requestId };
  }

  @Post('projects/:projectId/archive')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'projectId', schema: { type: 'string', pattern: '^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiBody({ type: ProjectVersionDto }) @ApiOkResponse({ type: ProjectEnvelopeDto }) @MutationHeaders() @ApiErrors()
  async archive(@Param('projectId') pid: string, @Body() body: ProjectVersionDto, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.projects.archive(req.auth!, pid, body.expectedVersion, req.requestId, idem, mutationId), requestId: req.requestId };
  }

  @Post('projects/:projectId/unarchive')
  @HttpCode(HttpStatus.OK)
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'projectId', schema: { type: 'string', pattern: '^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiBody({ type: ProjectVersionDto }) @ApiOkResponse({ type: ProjectEnvelopeDto }) @MutationHeaders() @ApiErrors()
  async unarchive(@Param('projectId') pid: string, @Body() body: ProjectVersionDto, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.projects.unarchive(req.auth!, pid, body.expectedVersion, req.requestId, idem, mutationId), requestId: req.requestId };
  }
}

function MutationHeaders() {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    ApiHeader({ name: 'Origin', required: true })(target, propertyKey, descriptor);
    ApiHeader({ name: 'X-CSRF-Protection', required: true, schema: { enum: ['1'], type: 'string' } })(target, propertyKey, descriptor);
    ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._-]+$' } })(target, propertyKey, descriptor);
    ApiHeader({ name: 'X-Client-Mutation-Id', required: true, schema: { type: 'string', pattern: '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })(target, propertyKey, descriptor);
  };
}
function ApiErrors() {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    for (const decorator of [ApiBadRequestResponse({ type: ErrorEnvelopeDto }), ApiUnauthorizedResponse({ type: ErrorEnvelopeDto }),
      ApiForbiddenResponse({ type: ErrorEnvelopeDto }), ApiNotFoundResponse({ type: ErrorEnvelopeDto }), ApiConflictResponse({ type: ErrorEnvelopeDto }),
      ApiUnprocessableEntityResponse({ type: ErrorEnvelopeDto }), ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto }),
      ApiResponse({ status: 423, type: ErrorEnvelopeDto }), ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto }),
      ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto })]) decorator(target, propertyKey, descriptor);
  };
}
function ReadErrors() {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    for (const decorator of [ApiBadRequestResponse({ type: ErrorEnvelopeDto }), ApiUnauthorizedResponse({ type: ErrorEnvelopeDto }),
      ApiNotFoundResponse({ type: ErrorEnvelopeDto }), ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto }),
      ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto })]) decorator(target, propertyKey, descriptor);
  };
}
