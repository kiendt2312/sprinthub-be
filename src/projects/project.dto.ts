import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsString, Max, Min, Validate, ValidateIf, ValidatorConstraint } from 'class-validator';
import type { ValidationArguments, ValidatorConstraintInterface } from 'class-validator';

export const PROJECT_DESCRIPTION_LIMIT = 8_000;

@ValidatorConstraint({ name: 'projectName', async: false })
class ProjectName implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments) {
    if (typeof value !== 'string' || !value.isWellFormed()) return false;
    const [min, max] = args.constraints as [number, number];
    const normalized = value.trim();
    return normalized.length > 0 && Array.from(normalized).length >= min && Array.from(normalized).length <= max;
  }
}

@ValidatorConstraint({ name: 'projectKey', async: false })
class ProjectKey implements ValidatorConstraintInterface {
  validate(value: unknown) { return typeof value === 'string' && /^[A-Z0-9]{2,10}$/.test(value); }
}

@ValidatorConstraint({ name: 'projectDescription', async: false })
class ProjectDescription implements ValidatorConstraintInterface {
  validate(value: unknown) { return typeof value === 'string' && value.isWellFormed() && Array.from(value).length <= PROJECT_DESCRIPTION_LIMIT; }
}

export class CreateProjectDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString() @Validate(ProjectName, [1, 100])
  name!: string;

  @ApiProperty({ minLength: 2, maxLength: 10, pattern: '^[A-Z0-9]{2,10}$' })
  @IsString() @Validate(ProjectKey)
  key!: string;

  @ApiPropertyOptional({ maxLength: PROJECT_DESCRIPTION_LIMIT })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString() @Validate(ProjectDescription)
  description?: string;
}

export class PatchProjectDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;

  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString() @Validate(ProjectName, [1, 100])
  name?: string;

  @ApiPropertyOptional({ minLength: 2, maxLength: 10, pattern: '^[A-Z0-9]{2,10}$' })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString() @Validate(ProjectKey)
  key?: string;

  @ApiPropertyOptional({ maxLength: PROJECT_DESCRIPTION_LIMIT })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString() @Validate(ProjectDescription)
  description?: string;
}

export class ProjectQueryDto {
  @ApiPropertyOptional({ type: 'boolean', default: false })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsIn(['true', 'false'])
  archived?: string;

  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 50 })
  @ValidateIf((_obj, value) => value !== undefined)
  @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  @ApiPropertyOptional({ maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' })
  @ValidateIf((_obj, value) => value !== undefined)
  @IsString()
  cursor?: string;
}

export class ProjectVersionDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;
}
