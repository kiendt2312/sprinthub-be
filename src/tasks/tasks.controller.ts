import { Body, Controller, Delete, Get, Headers, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { ApiRequest } from '../platform/http/request.js';
import { ErrorEnvelopeDto } from '../platform/http/errors.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { BoardQuota, SessionGuard } from '../auth/auth.guard.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { NoQueryGuard } from '../users/no-query.guard.js';
import { AssignTaskDto, CreateTaskDto, DeleteTaskDto, MoveTaskDto, TaskQueryDto, UpdateTaskDto } from './task.dto.js';
import { TasksService } from './tasks.service.js';
import { BoardEnvelopeDto, TaskEnvelopeDto, TaskListEnvelopeDto, TaskMutationEnvelopeDto, TaskPlacementEnvelopeDto } from './task.openapi.js';

@ApiTags('tasks')
@ApiCookieAuth('session')
@Controller('api/v1')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post('projects/:projectId/tasks')
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'projectId', schema: { type: 'string', pattern: '^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiCreatedResponse({ type: TaskPlacementEnvelopeDto })
  @ApiBody({ type: CreateTaskDto })
  @MutationHeaders()
  async create(@Param('projectId') projectId: string, @Body() body: CreateTaskDto, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.tasks.create(req.auth!, projectId, body, req.requestId, idem, mutationId), requestId: req.requestId };
  }

  @Get('projects/:projectId/tasks')
  @UseGuards(SessionGuard)
  @ApiParam({ name: 'projectId', schema: { type: 'string', pattern: '^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @TaskQueryDocs()
  @ApiOkResponse({ type: TaskListEnvelopeDto })
  @TaskReadErrors(400, 401, 404, 500, 503)
  async list(@Param('projectId') projectId: string, @Query() query: TaskQueryDto, @Req() req: ApiRequest & AuthenticatedRequest) {
    return { ...await this.tasks.list(req.auth!, projectId, query), requestId: req.requestId };
  }

  @Get('projects/:projectId/board')
  @ApiOkResponse({ type: BoardEnvelopeDto })
  @TaskReadErrors(400, 401, 404, 429, 500, 503)
  @BoardQuota()
  @UseGuards(SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'projectId', schema: { type: 'string', pattern: '^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  async board(@Param('projectId') projectId: string, @Req() req: ApiRequest & AuthenticatedRequest) {
    return { ...(await this.tasks.board(req.auth!, projectId)), requestId: req.requestId };
  }

  @Get('tasks/:taskId')
  @ApiOkResponse({ type: TaskEnvelopeDto })
  @TaskReadErrors(400, 401, 404, 500, 503)
  @UseGuards(SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'taskId', schema: { type: 'string', pattern: '^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  async get(@Param('taskId') taskId: string, @Req() req: ApiRequest & AuthenticatedRequest) {
    return { ...await this.tasks.get(req.auth!, taskId), requestId: req.requestId };
  }

  @Get('workspaces/:workspaceId/tasks/by-key/:key')
  @ApiOkResponse({ type: TaskEnvelopeDto })
  @TaskReadErrors(400, 401, 404, 500, 503)
  @UseGuards(SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'workspaceId', schema: { type: 'string', pattern: '^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiParam({ name: 'key', schema: { type: 'string', pattern: '^[A-Z0-9]{2,10}-[1-9][0-9]*$' } })
  async byKey(@Param('workspaceId') workspaceId: string, @Param('key') key: string, @Req() req: ApiRequest & AuthenticatedRequest) {
    return { ...await this.tasks.byKey(req.auth!, workspaceId, key), requestId: req.requestId };
  }

  @Patch('tasks/:taskId')
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'taskId', schema: { type: 'string', pattern: '^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiOkResponse({ type: TaskMutationEnvelopeDto })
  @ApiBody({ type: UpdateTaskDto })
  @MutationHeaders()
  async update(@Param('taskId') taskId: string, @Body() body: UpdateTaskDto, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.tasks.update(req.auth!, taskId, body, req.requestId, idem, mutationId), requestId: req.requestId };
  }

  @Patch('tasks/:taskId/assignee')
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'taskId', schema: { type: 'string', pattern: '^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiOkResponse({ type: TaskMutationEnvelopeDto })
  @ApiBody({ type: AssignTaskDto })
  @MutationHeaders()
  async assign(@Param('taskId') taskId: string, @Body() body: AssignTaskDto, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.tasks.assign(req.auth!, taskId, body, req.requestId, idem, mutationId), requestId: req.requestId };
  }

  @Patch('tasks/:taskId/move')
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard)
  @ApiParam({ name: 'taskId', schema: { type: 'string', pattern: '^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiOkResponse({ type: TaskPlacementEnvelopeDto })
  @ApiBody({ type: MoveTaskDto })
  @MutationHeaders()
  async move(@Param('taskId') taskId: string, @Body() body: MoveTaskDto, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.tasks.move(req.auth!, taskId, body, req.requestId, idem, mutationId), requestId: req.requestId };
  }

  @Delete('tasks/:taskId')
  @UseGuards(CsrfGuard, SessionGuard, NoQueryGuard)
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'taskId', schema: { type: 'string', pattern: '^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })
  @ApiOkResponse({ type: TaskMutationEnvelopeDto })
  @ApiBody({ type: DeleteTaskDto })
  @MutationHeaders()
  async delete(@Param('taskId') taskId: string, @Body() body: DeleteTaskDto, @Req() req: ApiRequest & AuthenticatedRequest,
    @Headers('idempotency-key') idem: string, @Headers('x-client-mutation-id') mutationId: string) {
    return { ...await this.tasks.delete(req.auth!, taskId, body.expectedVersion, req.requestId, idem, mutationId), requestId: req.requestId };
  }
}

function TaskReadErrors(...statuses: number[]) {
  return (target: object, key: string | symbol, descriptor: PropertyDescriptor) => {
    for (const status of statuses) ApiResponse({ status, type: ErrorEnvelopeDto })(target, key, descriptor);
  };
}

function MutationHeaders() {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    TaskReadErrors(400, 401, 403, 404, 409, 422, 423, 429, 500, 503)(target, propertyKey, descriptor);
    ApiHeader({ name: 'Origin', required: true })(target, propertyKey, descriptor);
    ApiHeader({ name: 'X-CSRF-Protection', required: true, schema: { enum: ['1'], type: 'string' } })(target, propertyKey, descriptor);
    ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._-]+$' } })(target, propertyKey, descriptor);
    ApiHeader({ name: 'X-Client-Mutation-Id', required: true, schema: { type: 'string', pattern: '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' } })(target, propertyKey, descriptor);
  };
}

function TaskQueryDocs() {
  return (target: object, propertyKey: string | symbol, descriptor: PropertyDescriptor) => {
    for (const [name, enumValues] of [['status', ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE']], ['priority', ['LOW', 'MEDIUM', 'HIGH', 'URGENT']]] as const) {
      ApiQuery({ name, required: false, type: String, enum: [...enumValues] })(target, propertyKey, descriptor);
    }
    ApiQuery({ name: 'assigneeId', required: false, type: String, description: 'Use UNASSIGNED for tasks without an assignee.' })(target, propertyKey, descriptor);
    ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } })(target, propertyKey, descriptor);
    ApiQuery({ name: 'cursor', required: false, type: String, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' })(target, propertyKey, descriptor);
  };
}
