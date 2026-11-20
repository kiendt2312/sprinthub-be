import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '../platform/http/errors.js';

@Injectable()
export class NoQueryGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (Object.keys(request.query).length > 0) throw new ApiError(400, 'VALIDATION_FAILED');
    return true;
  }
}
