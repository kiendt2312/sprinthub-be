import { ApiProperty } from '@nestjs/swagger';
import { PROJECT_DESCRIPTION_LIMIT } from './project.dto.js';

export class ProjectDto {
  @ApiProperty({ pattern: '^prj_[0-7][0-9A-HJKMNP-TV-Z]{25}$' }) id!: string;
  @ApiProperty({ pattern: '^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$' }) workspaceId!: string;
  @ApiProperty({ minLength: 1, maxLength: 100 }) name!: string;
  @ApiProperty({ pattern: '^[A-Z0-9]{2,10}$' }) key!: string;
  @ApiProperty({ maxLength: PROJECT_DESCRIPTION_LIMIT }) description!: string;
  @ApiProperty({ pattern: '^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$' }) createdBy!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) createdAtMs!: number;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) archivedAt!: string | null;
  @ApiProperty({ type: 'integer', minimum: 1 }) version!: number;
}

export class ProjectEnvelopeDto {
  @ApiProperty({ type: ProjectDto }) data!: ProjectDto;
  @ApiProperty({ type: 'integer', minimum: 0 }) seq!: number;
  @ApiProperty() requestId!: string;
}

export class ProjectListEnvelopeDto {
  @ApiProperty({ type: [ProjectDto] }) data!: ProjectDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() requestId!: string;
}
