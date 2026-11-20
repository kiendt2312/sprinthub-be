import { createHash } from 'node:crypto';
import { Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError } from '../platform/http/errors.js';
import { cookieToken } from './auth.security.js';
import { AuthService } from './auth.service.js';
import { AuthRepository } from './auth.repository.js';
import { rateLimited } from './auth.responses.js';
import { timestamp, USER_ID } from './auth.types.js';
import type { AuthenticatedRequest } from './auth.types.js';

const BOARD_QUOTA = Symbol('BOARD_QUOTA');

export const BoardQuota = () => SetMetadata(BOARD_QUOTA, true);

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly repository: AuthRepository,
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const token = cookieToken(request);
    if (!token) throw new ApiError(401, 'SESSION_INVALID');
    const digest = createHash('sha256').update(token).digest('hex');
    const boardQuota = this.reflector.get<boolean>(BOARD_QUOTA, context.getHandler());
    const quota = boardQuota
      ? { policy: 'board' as const, subject: digest, limit: 120, windowSeconds: 60 }
      : request.authRateLimit;
    const batch = quota ? await this.repository.getSessionWithQuota(digest, quota) : undefined;
    const session = batch ? batch.session : await this.repository.getSession(digest);
    const { userId } = session;
    const now = Date.now();
    const expiresAt = timestamp(session.expiresAtMs);
    const absoluteExpiresAt = timestamp(session.absoluteExpiresAtMs);
    if (!userId || !USER_ID.test(userId) || !expiresAt || !absoluteExpiresAt
      || expiresAt <= now || absoluteExpiresAt <= now) throw new ApiError(401, 'SESSION_INVALID');
    if (batch && quota && batch.count > quota.limit) {
      const retryAfter = batch.ttl >= 0 ? Math.max(1, Math.ceil(batch.ttl / 1000)) : quota.windowSeconds;
      throw rateLimited([{ policy: quota.policy, retryAfter }]);
    }
    const lastSeenAtMs = timestamp(session.lastSeenAtMs);
    request.auth = { userId, digest, lastSeenAtMs: lastSeenAtMs ?? now };
    if (lastSeenAtMs && now - lastSeenAtMs > this.auth.sessionTouchMs) {
      response.once('finish', () => { void this.auth.onSessionTouch(userId, digest, request.requestId); });
    }
    return true;
  }
}
