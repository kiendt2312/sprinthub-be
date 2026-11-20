import { ApiProperty } from '@nestjs/swagger';

export class WorkspaceDto {
  @ApiProperty({ pattern: '^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ pattern: '^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$' }) ownerId!: string;
  @ApiProperty({ enum: ['OWNER', 'ADMIN', 'MEMBER'] }) role!: 'OWNER' | 'ADMIN' | 'MEMBER';
  @ApiProperty({ type: 'integer', minimum: 1 }) version!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) createdAtMs!: number;
}

export class WorkspaceEnvelopeDto {
  @ApiProperty({ type: WorkspaceDto }) data!: WorkspaceDto;
  @ApiProperty({ type: 'integer', minimum: 0 }) seq!: number;
  @ApiProperty() requestId!: string;
}

export class WorkspaceListEnvelopeDto {
  @ApiProperty({ type: [WorkspaceDto] }) data!: WorkspaceDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty() requestId!: string;
}

export class MemberDto {
  @ApiProperty({ pattern: '^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$' }) userId!: string;
  @ApiProperty({ enum: ['OWNER', 'ADMIN', 'MEMBER'] }) role!: 'OWNER' | 'ADMIN' | 'MEMBER';
}

export class MembersEnvelopeDto {
  @ApiProperty({ type: [MemberDto] }) data!: MemberDto[];
  @ApiProperty({ type: 'integer', minimum: 1 }) workspaceVersion!: number;
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
  @ApiProperty({ type: 'integer', minimum: 0 }) seq!: number;
  @ApiProperty() requestId!: string;
}

export class MemberEnvelopeDto {
  @ApiProperty({ type: MemberDto }) data!: MemberDto;
  @ApiProperty({ type: 'integer', minimum: 0 }) seq!: number;
  @ApiProperty() requestId!: string;
}

export class RemovedMemberDto {
  @ApiProperty({ pattern: '^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$' }) userId!: string;
}

export class RemovedMemberEnvelopeDto {
  @ApiProperty({ type: RemovedMemberDto }) data!: RemovedMemberDto;
  @ApiProperty({ type: 'integer', minimum: 0 }) seq!: number;
  @ApiProperty() requestId!: string;
}
