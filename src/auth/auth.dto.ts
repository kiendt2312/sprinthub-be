import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, Min, Validate, ValidateIf, ValidatorConstraint } from 'class-validator';
import type { ValidationArguments, ValidatorConstraintInterface } from 'class-validator';

@ValidatorConstraint({ name: 'codePointLength', async: false })
class CodePointLength implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments) {
    if (typeof value !== 'string') return false;
    const [min, max] = args.constraints as [number, number];
    const length = Array.from(value).length;
    return length >= min && length <= max;
  }
}

@ValidatorConstraint({ name: 'trimmedCodePointLength', async: false })
class TrimmedCodePointLength implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments) {
    if (typeof value !== 'string') return false;
    const [min, max] = args.constraints as [number, number];
    const length = Array.from(value.trim()).length;
    return length >= min && length <= max;
  }
}

@ValidatorConstraint({ name: 'httpsAvatarUrl', async: false })
class HttpsAvatarUrl implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (value === null) return true;
    if (typeof value !== 'string' || Array.from(value).length > 2048 || /\s/.test(value) || !/^https:\/\//i.test(value)) return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
    } catch { return false; }
  }
}

export class RegisterDto {
  @ApiProperty({ example: 'person@example.com', maxLength: 254 })
  @IsString()
  email!: string;

  @ApiProperty({ minLength: 15, maxLength: 128 })
  @IsString()
  @Validate(CodePointLength, [15, 128])
  password!: string;

  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @Validate(TrimmedCodePointLength, [1, 80])
  displayName!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'person@example.com', maxLength: 254 })
  @IsString()
  email!: string;

  @ApiProperty({ minLength: 15, maxLength: 128 })
  @IsString()
  @Validate(CodePointLength, [15, 128])
  password!: string;
}

export class PatchProfileDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion!: number;

  @ApiProperty({ required: false, minLength: 1, maxLength: 80 })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Validate(TrimmedCodePointLength, [1, 80])
  displayName?: string;

  @ApiProperty({ required: false, nullable: true, type: String, format: 'uri', maxLength: 2048 })
  @ValidateIf((_object, value) => value !== undefined)
  @Validate(HttpsAvatarUrl)
  avatarUrl?: string | null;

  @ApiProperty({ required: false, enum: ['en', 'vi'] })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['en', 'vi'])
  locale?: 'en' | 'vi';
}
