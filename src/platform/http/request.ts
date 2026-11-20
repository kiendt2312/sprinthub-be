import type { OutgoingHttpHeader, OutgoingHttpHeaders } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { monotonicFactory } from 'ulid';
import { log } from '../log.js';

const nextId = monotonicFactory();

export function makeId(prefix: string) {
  return `${prefix}_${nextId()}`;
}

export interface ApiRequest extends Request {
  requestId: string;
}

export function requestContext(request: ApiRequest, response: Response, next: NextFunction) {
  const start = performance.now();
  request.requestId = makeId('req');
  response.set({ 'X-Request-Id': request.requestId, 'Cache-Control': 'no-store' });

  const writeHead = response.writeHead.bind(response);
  response.writeHead = (
    statusCode: number,
    messageOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
    headers?: OutgoingHttpHeaders | OutgoingHttpHeader[],
  ) => {
    response.setHeader('Server-Timing', `app;dur=${(performance.now() - start).toFixed(3)}`);
    return typeof messageOrHeaders === 'string'
      ? writeHead(statusCode, messageOrHeaders, headers)
      : writeHead(statusCode, messageOrHeaders);
  };

  response.once('finish', () => log('info', 'http_request', {
    requestId: request.requestId,
    method: request.method,
    status: response.statusCode,
    durationMs: Math.round(performance.now() - start),
  }));
  next();
}
