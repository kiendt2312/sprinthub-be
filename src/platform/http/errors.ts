import { Catch, HttpException } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ApiProperty } from '@nestjs/swagger';
import { RedisFailure } from '../../redis/client.js';
import { log } from '../log.js';
import type { ApiRequest } from './request.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly params: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

class ErrorDetailDto {
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) params!: Record<string, unknown>;
}

export class ErrorEnvelopeDto {
  @ApiProperty({ type: ErrorDetailDto }) error!: ErrorDetailDto;
  @ApiProperty({ type: String }) requestId!: string;
}

function publicError(error: unknown) {
  if (error instanceof ApiError) return error;
  if (error instanceof RedisFailure) return new ApiError(error.code === 'INTERNAL_ERROR' ? 500 : 503, error.code);
  const status = error instanceof HttpException ? error.getStatus() : undefined;
  if (status === 404) return new ApiError(404, 'NOT_FOUND');
  if (status !== undefined && status >= 400 && status < 500) return new ApiError(400, 'VALIDATION_FAILED');
  return new ApiError(500, 'INTERNAL_ERROR');
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<ApiRequest>();
    const response = http.getResponse<Response>();
    sendError(request, response, publicError(error));
  }
}

export function sendError(request: ApiRequest, response: Response, error: ApiError) {
  log(error.status >= 500 ? 'error' : 'info', 'http_error', {
    requestId: request.requestId,
    status: error.status,
    code: error.code,
  });
  response.set(error.headers).status(error.status).json({
    error: { code: error.code, params: error.params },
    requestId: request.requestId,
  });
}
