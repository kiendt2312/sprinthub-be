import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiError } from '../platform/http/errors.js';
import type { PatchProfileDto } from '../auth/auth.dto.js';
import type { CurrentSession } from '../auth/auth.types.js';
import { AuthService } from '../auth/auth.service.js';
import { AuthRepository } from '../auth/auth.repository.js';
import { authResult, publicProfile } from '../auth/auth.responses.js';
import { SESSION_ID, timestamp } from '../auth/auth.types.js';

export interface SessionView {
  id: string;
  createdAtMs: number;
  lastSeenAtMs: number;
  expiresAtMs: number;
  absoluteExpiresAtMs: number;
  current: boolean;
}

@Injectable()
export class UsersService {
  constructor(private readonly repository: AuthRepository, private readonly auth: AuthService) {}

  async getProfile(session: CurrentSession) {
    return publicProfile(await this.repository.getUser(session.userId));
  }

  async getSessions(session: CurrentSession) {
    const rows = await this.repository.listSessions(session.userId);
    const now = Date.now();
    const valid: SessionView[] = [];
    for (const { digest, record } of rows) {
      if (record.userId !== session.userId || !record.id || !SESSION_ID.test(record.id)) continue;
      const createdAtMs = timestamp(record.createdAtMs);
      const lastSeenAtMs = timestamp(record.lastSeenAtMs);
      const expiresAtMs = timestamp(record.expiresAtMs);
      const absoluteExpiresAtMs = timestamp(record.absoluteExpiresAtMs);
      if (!createdAtMs || !lastSeenAtMs || !expiresAtMs || !absoluteExpiresAtMs
        || expiresAtMs <= now || absoluteExpiresAtMs <= now) continue;
      valid.push({ id: record.id, createdAtMs, lastSeenAtMs, expiresAtMs, absoluteExpiresAtMs, current: digest === session.digest });
    }
    return valid.sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async updateProfile(session: CurrentSession, dto: PatchProfileDto, idempotencyKey: string, mutationId: string) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(idempotencyKey) || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(mutationId)) {
      throw new ApiError(400, 'VALIDATION_FAILED');
    }
    const patch = {
      ...(dto.displayName === undefined ? {} : { displayName: dto.displayName.trim() }),
      ...(dto.avatarUrl === undefined ? {} : { avatarUrl: dto.avatarUrl }),
      ...(dto.locale === undefined ? {} : { locale: dto.locale }),
    };
    if (Object.keys(patch).length === 0) throw new ApiError(400, 'VALIDATION_FAILED');
    await this.auth.takeWriteLimit(session.userId);
    const requestHash = createHash('sha256').update(JSON.stringify([
      'sh_update_my_profile', session.userId, dto.expectedVersion, patch, mutationId,
    ])).digest('hex');
    return publicProfile(authResult(await this.repository.updateProfile(
      session, dto.expectedVersion, patch, idempotencyKey, requestHash,
    )));
  }
}
