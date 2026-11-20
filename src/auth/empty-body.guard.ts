import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '../platform/http/errors.js';

@Injectable()
export class EmptyBodyGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const hasBody = request.headers['transfer-encoding'] !== undefined
      || Number(request.headers['content-length'] ?? 0) > 0;
    if (hasBody && !request.is('application/json')) throw new ApiError(400, 'VALIDATION_FAILED');
    const body: unknown = request.body;
    if (body !== undefined && (body === null || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 0)) throw new ApiError(400, 'VALIDATION_FAILED');
    return true;
  }
}
