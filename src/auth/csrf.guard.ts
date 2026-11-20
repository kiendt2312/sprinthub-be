import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { RuntimeConfig } from '../platform/config.js';
import { RUNTIME_CONFIG } from '../redis/redis.module.js';
import { assertCsrf } from './auth.security.js';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig & { authOrigin: string }) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    assertCsrf(request, this.config.authOrigin);
    return true;
  }
}
