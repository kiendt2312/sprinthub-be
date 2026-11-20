import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBody, ApiConflictResponse, ApiCookieAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiHeader, ApiInternalServerErrorResponse, ApiNotFoundResponse, ApiOkResponse, ApiParam, ApiQuery, ApiResponse, ApiServiceUnavailableResponse, ApiTags, ApiTooManyRequestsResponse, ApiUnauthorizedResponse, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import { ErrorEnvelopeDto } from '../platform/http/errors.js';
import type { ApiRequest } from '../platform/http/request.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard } from '../auth/auth.guard.js';
import { EmptyBodyGuard } from '../auth/empty-body.guard.js';
import { NoQueryGuard } from '../users/no-query.guard.js';
import { AddWorkspaceMemberDto, CreateWorkspaceDto, PatchWorkspaceDto, TransferWorkspaceOwnerDto, UpdateWorkspaceRoleDto, WorkspaceQueryDto } from './workspace.dto.js';
import { MemberEnvelopeDto, MembersEnvelopeDto, RemovedMemberEnvelopeDto, WorkspaceEnvelopeDto, WorkspaceListEnvelopeDto } from './workspace.openapi.js';
import { WorkspaceService } from './workspace.service.js';

@ApiTags('workspaces')
@ApiCookieAuth('session')
@Controller('api/v1/workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspaceService) {}

  @Post()
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard)
  @ApiBody({ type: CreateWorkspaceDto })
  @ApiCreatedResponse({ type: WorkspaceEnvelopeDto })
  @MutationHeaders() @ApiErrors()
  async create(@Body() body: CreateWorkspaceDto, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    const result = await this.workspaces.create(req.auth!, body, req.requestId, idem, mutationId);
    return { ...result, requestId: req.requestId };
  }

  @Get()
  @UseGuards(SessionGuard)
  @WorkspaceQueryDocs()
  @ApiOkResponse({ type: WorkspaceListEnvelopeDto })
  @ApiBadRequestResponse({ type: ErrorEnvelopeDto }) @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto })
  @ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto }) @ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto })
  async list(@Query() query: WorkspaceQueryDto, @Req() req: ApiRequest & AuthenticatedRequest) {
    return { ...await this.workspaces.list(req.auth!, query.limit ?? 50, query.cursor), requestId: req.requestId };
  }

  @Get(':workspaceId')
  @UseGuards(SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'workspaceId', schema: { type: 'string', pattern: '^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiOkResponse({ type: WorkspaceEnvelopeDto }) @ApiBadRequestResponse({ type: ErrorEnvelopeDto })
  @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto }) @ApiNotFoundResponse({ type: ErrorEnvelopeDto })
  @ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto }) @ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto })
  async get(@Param('workspaceId') id: string, @Req() req: ApiRequest & AuthenticatedRequest) {
    return { ...await this.workspaces.get(req.auth!, id), requestId: req.requestId };
  }

  @Patch(':workspaceId')
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'workspaceId', schema: { type: 'string', pattern: '^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiBody({ type: PatchWorkspaceDto }) @ApiOkResponse({ type: WorkspaceEnvelopeDto })
  @MutationHeaders() @ApiErrors()
  async update(@Param('workspaceId') id: string, @Body() body: PatchWorkspaceDto, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.workspaces.update(req.auth!, id, body, req.requestId, idem, mutationId), requestId: req.requestId };
  }

  @Get(':workspaceId/members')
  @UseGuards(SessionGuard)
  @WorkspaceQueryDocs()
  @ApiParam({ name: 'workspaceId', schema: { type: 'string', pattern: '^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiOkResponse({ type: MembersEnvelopeDto }) @ApiBadRequestResponse({ type: ErrorEnvelopeDto })
  @ApiUnauthorizedResponse({ type: ErrorEnvelopeDto }) @ApiNotFoundResponse({ type: ErrorEnvelopeDto })
  @ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto }) @ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto })
  async members(@Param('workspaceId') id: string, @Query() query: WorkspaceQueryDto, @Req() req: ApiRequest & AuthenticatedRequest) {
    return { ...await this.workspaces.listMembers(req.auth!, id, query.limit ?? 50, query.cursor), requestId: req.requestId };
  }

  @Post(':workspaceId/members')
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'workspaceId', schema: { type: 'string', pattern: '^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiBody({ type: AddWorkspaceMemberDto }) @ApiCreatedResponse({ type: MemberEnvelopeDto })
  @MutationHeaders() @ApiErrors()
  async addMember(@Param('workspaceId') id: string, @Body() body: AddWorkspaceMemberDto, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.workspaces.addMember(req.auth!, id, body, req.requestId, idem, mutationId), requestId: req.requestId };
  }

  @Patch(':workspaceId/members/:userId')
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'workspaceId', schema: { type: 'string', pattern: '^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiParam({ name: 'userId', schema: { type: 'string', pattern: '^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiBody({ type: UpdateWorkspaceRoleDto }) @ApiOkResponse({ type: MemberEnvelopeDto })
  @MutationHeaders() @ApiErrors()
  async updateRole(@Param('workspaceId') id: string, @Param('userId') userId: string, @Body() body: UpdateWorkspaceRoleDto,
    @Req() req: ApiRequest & AuthenticatedRequest, @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.workspaces.updateRole(req.auth!, id, userId, body, req.requestId, idem, mutationId), requestId: req.requestId };
  }

  @Delete(':workspaceId/members/:userId')
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard, EmptyBodyGuard)
  @HttpCode(HttpStatus.OK) @ApiBody({ required: false, schema: { type: 'object', additionalProperties: false } })
  @ApiParam({ name: 'workspaceId', schema: { type: 'string', pattern: '^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiParam({ name: 'userId', schema: { type: 'string', pattern: '^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiOkResponse({ type: RemovedMemberEnvelopeDto }) @MutationHeaders() @ApiErrors()
  async removeMember(@Param('workspaceId') id: string, @Param('userId') userId: string, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.workspaces.removeMember(req.auth!, id, userId, req.requestId, idem, mutationId), requestId: req.requestId };
  }

  @Post(':workspaceId/leave')
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard, EmptyBodyGuard)
  @HttpCode(HttpStatus.OK) @ApiBody({ required: false, schema: { type: 'object', additionalProperties: false } })
  @ApiParam({ name: 'workspaceId', schema: { type: 'string', pattern: '^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiOkResponse({ type: RemovedMemberEnvelopeDto }) @MutationHeaders() @ApiErrors()
  async leave(@Param('workspaceId') id: string, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.workspaces.leave(req.auth!, id, req.requestId, idem, mutationId), requestId: req.requestId };
  }

  @Post(':workspaceId/transfer-ownership')
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'workspaceId', schema: { type: 'string', pattern: '^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiBody({ type: TransferWorkspaceOwnerDto }) @ApiOkResponse({ type: WorkspaceEnvelopeDto })
  @MutationHeaders() @ApiErrors()
  async transfer(@Param('workspaceId') id: string, @Body() body: TransferWorkspaceOwnerDto, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.workspaces.transferOwner(req.auth!, id, body.userId, req.requestId, idem, mutationId), requestId: req.requestId };
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

function WorkspaceQueryDocs() {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100, example: 50 })(target, propertyKey, descriptor);
    ApiQuery({ name: 'cursor', required: false, type: String, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' })(target, propertyKey, descriptor);
  };
}

function ApiErrors() {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    for (const decorator of [ApiBadRequestResponse({ type: ErrorEnvelopeDto }), ApiUnauthorizedResponse({ type: ErrorEnvelopeDto }),
      ApiForbiddenResponse({ type: ErrorEnvelopeDto }), ApiNotFoundResponse({ type: ErrorEnvelopeDto }),
      ApiConflictResponse({ type: ErrorEnvelopeDto }),
      ApiUnprocessableEntityResponse({ type: ErrorEnvelopeDto }), ApiTooManyRequestsResponse({ type: ErrorEnvelopeDto, headers: {
        'Retry-After': { schema: { type: 'integer' } }, RateLimit: { schema: { type: 'string' } },
      } }), ApiResponse({ status: 423, type: ErrorEnvelopeDto }),
      ApiInternalServerErrorResponse({ type: ErrorEnvelopeDto }), ApiServiceUnavailableResponse({ type: ErrorEnvelopeDto })]) {
      decorator(target, propertyKey, descriptor);
    }
  };
}
