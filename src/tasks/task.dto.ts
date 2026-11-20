import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Max, Min, Validate, ValidateIf, ValidatorConstraint } from 'class-validator';
import type { ValidationArguments, ValidatorConstraintInterface } from 'class-validator';

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
const STATUSES = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'] as const;

@ValidatorConstraint({ name: 'taskText', async: false })
class TaskText implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments) {
    if (typeof value !== 'string' || !value.isWellFormed()) return false;
    const [min, max, trim] = args.constraints as [number, number, boolean];
    const text = trim ? value.trim() : value;
    const length = Array.from(text).length;
    return length >= min && length <= max;
  }
}

@ValidatorConstraint({ name: 'nonNegativeSafeIntegerOrNull', async: false })
class NonNegativeSafeIntegerOrNull implements ValidatorConstraintInterface {
  validate(value: unknown) { return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0); }
}

@ValidatorConstraint({ name: 'taskId', async: false })
class TaskIdConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) { return typeof value === 'string' && /^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value); }
}

export class CreateTaskDto {
  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString() @Validate(TaskText, [1, 200, true])
  title!: string;

  @ApiPropertyOptional({ maxLength: 20_000 })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString() @Validate(TaskText, [0, 20_000, false])
  description?: string;

  @ApiPropertyOptional({ enum: PRIORITIES, default: 'MEDIUM' })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(PRIORITIES)
  priority?: typeof PRIORITIES[number];

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, nullable: true })
  @ValidateIf((_obj, value) => value !== undefined)
  @Validate(NonNegativeSafeIntegerOrNull)
  dueAtMs?: number | null;

  @ApiPropertyOptional({ type: String, pattern: '^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$', nullable: true })
  @ValidateIf((_obj, value) => value !== undefined && value !== null)
  @IsString()
  assigneeId?: string | null;
}

export class UpdateTaskDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;

  @ApiPropertyOptional({ minLength: 1, maxLength: 200 })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString() @Validate(TaskText, [1, 200, true])
  title?: string;

  @ApiPropertyOptional({ maxLength: 20_000 })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString() @Validate(TaskText, [0, 20_000, false])
  description?: string;

  @ApiPropertyOptional({ enum: PRIORITIES })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(PRIORITIES)
  priority?: typeof PRIORITIES[number];

  @ApiPropertyOptional({ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, nullable: true })
  @ValidateIf((_obj, value) => value !== undefined)
  @Validate(NonNegativeSafeIntegerOrNull)
  dueAtMs?: number | null;

  @ApiPropertyOptional({ type: String, pattern: '^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$', nullable: true })
  @ValidateIf((_obj, value) => value !== undefined && value !== null)
  @IsString()
  assigneeId?: string | null;
}

export class AssignTaskDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;

  @ApiProperty({ type: String, pattern: '^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$', nullable: true })
  @ValidateIf((_obj, value) => value !== null)
  @IsString()
  assigneeId!: string | null;
}

export class MoveTaskDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;

  @ApiProperty({ enum: STATUSES })
  @IsIn(STATUSES)
  to!: typeof STATUSES[number];

  @ApiPropertyOptional({ type: String, pattern: '^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$', nullable: true })
  @ValidateIf((_obj, value) => value !== undefined && value !== null)
  @IsString() @Validate(TaskIdConstraint)
  afterTaskId?: string | null;

  @ApiPropertyOptional({ type: String, pattern: '^tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}$', nullable: true })
  @ValidateIf((_obj, value) => value !== undefined && value !== null)
  @IsString() @Validate(TaskIdConstraint)
  beforeTaskId?: string | null;
}

export class DeleteTaskDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;
}

export class TaskQueryDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(STATUSES)
  status?: typeof STATUSES[number];

  @ApiPropertyOptional({ description: 'Use UNASSIGNED to select tasks without an assignee.' })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional({ enum: PRIORITIES })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(PRIORITIES)
  priority?: typeof PRIORITIES[number];

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 50 })
  @ValidateIf((_obj, value) => value !== undefined)
  @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  @ApiPropertyOptional({ maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString()
  cursor?: string;
}
