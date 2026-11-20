import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError } from '../platform/http/errors.js';
import { cookieToken } from './auth.security.js';
import { AuthService } from './auth.service.js';
import { AuthRepository } from './auth.repository.js';
import { rateLimited } from './auth.responses.js';
import { timestamp, USER_ID } from './auth.types.js';
import type { AuthenticatedRequest } from './auth.types.js';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly repository: AuthRepository, private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const token = cookieToken(request);
    if (!token) throw new ApiError(401, 'SESSION_INVALID');
    const digest = createHash('sha256').update(token).digest('hex');
    const quota = request.authRateLimit;
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
