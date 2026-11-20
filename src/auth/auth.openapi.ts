import { ApiProperty } from '@nestjs/swagger';

export class ProfileDto {
  @ApiProperty({ pattern: '^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$' }) id!: string;
  @ApiProperty({ format: 'email' }) email!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ nullable: true, type: String }) avatarUrl!: string | null;
  @ApiProperty({ enum: ['en', 'vi'] }) locale!: 'en' | 'vi';
  @ApiProperty({ type: 'integer', minimum: 1 }) version!: number;
}

export class ProfileEnvelopeDto {
  @ApiProperty({ type: ProfileDto }) data!: ProfileDto;
  @ApiProperty() requestId!: string;
}

export class RegisterAcceptedDto {
  @ApiProperty({ enum: ['accepted'] }) status!: 'accepted';
  @ApiProperty() requestId!: string;
}

export class SessionDto {
  @ApiProperty({ pattern: '^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$' }) id!: string;
  @ApiProperty({ type: 'integer', format: 'int64' }) createdAtMs!: number;
  @ApiProperty({ type: 'integer', format: 'int64' }) lastSeenAtMs!: number;
  @ApiProperty({ type: 'integer', format: 'int64' }) expiresAtMs!: number;
  @ApiProperty({ type: 'integer', format: 'int64' }) absoluteExpiresAtMs!: number;
  @ApiProperty() current!: boolean;
}

export class SessionsEnvelopeDto {
  @ApiProperty({ type: [SessionDto] }) data!: SessionDto[];
  @ApiProperty() requestId!: string;
}

export const issuedSessionCookie = {
  'Set-Cookie': {
    description: '__Host-sh_session=<opaque>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax',
    schema: { type: 'string' },
  },
};

export const clearedSessionCookie = {
  'Set-Cookie': {
    description: '__Host-sh_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    schema: { type: 'string' },
  },
};
