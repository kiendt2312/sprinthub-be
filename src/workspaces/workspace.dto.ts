import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Max, Min, Validate, ValidateIf, ValidatorConstraint } from 'class-validator';
import type { ValidationArguments, ValidatorConstraintInterface } from 'class-validator';

@ValidatorConstraint({ name: 'trimmedWorkspaceName', async: false })
class TrimmedWorkspaceName implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments) {
    if (typeof value !== 'string') return false;
    const [min, max] = args.constraints as [number, number];
    const normalized = value.trim();
    return normalized.length > 0 && Array.from(normalized).length >= min && Array.from(normalized).length <= max;
  }
}

@ValidatorConstraint({ name: 'workspaceSlug', async: false })
class WorkspaceSlug implements ValidatorConstraintInterface {
  validate(value: unknown) { return typeof value === 'string' && value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value); }
}

export class CreateWorkspaceDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString() @Validate(TrimmedWorkspaceName, [1, 100])
  name!: string;

  @ApiProperty({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' })
  @IsString() @Validate(WorkspaceSlug)
  slug!: string;
}

export class PatchWorkspaceDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;

  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString() @Validate(TrimmedWorkspaceName, [1, 100])
  name?: string;

  @ApiPropertyOptional({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString() @Validate(WorkspaceSlug)
  slug?: string;
}

export class AddWorkspaceMemberDto {
  @ApiPropertyOptional({ pattern: '^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$' })
  @ValidateIf((obj) => obj.email === undefined)
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ format: 'email', maxLength: 254 })
  @ValidateIf((obj) => obj.userId === undefined)
  @IsString()
  email?: string;
}

export class UpdateWorkspaceRoleDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;

  @ApiProperty({ enum: ['ADMIN', 'MEMBER'] })
  @IsIn(['ADMIN', 'MEMBER'])
  role!: 'ADMIN' | 'MEMBER';
}

export class TransferWorkspaceOwnerDto {
  @ApiProperty({ pattern: '^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$' })
  @IsString()
  userId!: string;
}

export class WorkspaceQueryDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 50 })
  @ValidateIf((_obj, value) => value !== undefined)
  @Type(() => Number)
  @IsInt() @Min(1) @Max(100)
  limit?: number;

  @ApiPropertyOptional({ maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString()
  cursor?: string;
}
