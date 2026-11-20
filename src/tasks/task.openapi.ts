import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TASK_STATUSES } from './task.repository.js';
import type { TaskStatus } from './task.repository.js';

const priorities = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
const taskId = '^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$';
const projectId = '^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$';
const workspaceId = '^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$';
const userId = '^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$';

class BoardCardDto {
  @ApiProperty({ pattern: taskId }) id!: string;
  @ApiProperty({ pattern: '^[A-Z0-9]{2,10}-[1-9][0-9]*$' }) key!: string;
  @ApiProperty({ minLength: 1, maxLength: 200 }) title!: string;
  @ApiProperty({ type: String, enum: priorities }) priority!: string;
  @ApiProperty({ type: String, nullable: true, pattern: userId }) assigneeId!: string | null;
  @ApiProperty({ type: 'integer', nullable: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) dueAtMs!: number | null;
  @ApiProperty({ type: [String] }) labelIds!: string[];
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) version!: number;
}

class TaskDto extends BoardCardDto {
  @ApiProperty({ pattern: workspaceId }) workspaceId!: string;
  @ApiProperty({ pattern: projectId }) projectId!: string;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) number!: number;
  @ApiProperty({ maxLength: 20_000 }) description!: string;
  @ApiProperty({ type: String, enum: ['markdown'] }) descriptionFormat!: 'markdown';
  @ApiProperty({ type: String, enum: TASK_STATUSES }) status!: TaskStatus;
  @ApiProperty({ pattern: userId }) reporterId!: string;
  @ApiProperty({ type: String, nullable: true }) sprintId!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) createdAtMs!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) deletedAt!: string | null;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) lastSeq!: number;
  @ApiProperty({ pattern: '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' }) lastClientMutationId!: string;
}

class BoardColumnsDto {
  @ApiProperty({ type: [BoardCardDto] }) TODO!: BoardCardDto[];
  @ApiProperty({ type: [BoardCardDto] }) IN_PROGRESS!: BoardCardDto[];
  @ApiProperty({ type: [BoardCardDto] }) IN_REVIEW!: BoardCardDto[];
  @ApiProperty({ type: [BoardCardDto] }) DONE!: BoardCardDto[];
}

class BoardDto {
  @ApiProperty({ pattern: projectId }) projectId!: string;
  @ApiProperty({ type: BoardColumnsDto }) columns!: BoardColumnsDto;
}

export class TaskEnvelopeDto {
  @ApiProperty({ type: TaskDto }) data!: TaskDto;
  @ApiProperty() requestId!: string;
}

export class TaskMutationEnvelopeDto extends TaskEnvelopeDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) seq!: number;
}

export class TaskPlacementEnvelopeDto extends TaskMutationEnvelopeDto {
  @ApiPropertyOptional({ type: String, enum: TASK_STATUSES }) rebalancedColumn?: TaskStatus;
}

export class TaskListEnvelopeDto {
  @ApiProperty({ type: [TaskDto] }) data!: TaskDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty() requestId!: string;
}

export class BoardEnvelopeDto {
  @ApiProperty({ type: BoardDto }) data!: BoardDto;
  @ApiProperty() requestId!: string;
}
