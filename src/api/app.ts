import 'reflect-metadata';
import { Module, ValidationPipe } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import type { NextFunction, Response } from 'express';
import type { RuntimeConfig } from '../platform/config.js';
import { ApiError, HttpErrorFilter, sendError } from '../platform/http/errors.js';
import type { ApiRequest } from '../platform/http/request.js';
import { requestContext } from '../platform/http/request.js';
import { nestLogger } from '../platform/log.js';
import { RedisModule } from '../redis/redis.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { UsersModule } from '../users/users.module.js';
import { HealthController } from './health.controller.js';

@Module({})
class ApiModule {}

export async function createApi(config: RuntimeConfig, extraImports: DynamicModule[] = []) {
  const app = await NestFactory.create<NestExpressApplication>({
    module: ApiModule,
    imports: [RedisModule.configure(config), AuthModule, UsersModule, ...extraImports],
    controllers: [HealthController],
  }, { logger: nestLogger, abortOnError: false, bodyParser: false, forceCloseConnections: false });

  app.set('trust proxy', config.trustedProxies.length ? config.trustedProxies : false);
  app.disable('x-powered-by');
  app.use(requestContext);
  app.use(express.json({
    limit: '32kb',
    reviver(key: string, value: unknown) {
      if (key === '__proto__' || key === 'constructor') throw new SyntaxError('Invalid JSON property');
      return value;
    },
  }));
  app.use((error: unknown, request: ApiRequest, response: Response, next: NextFunction) => {
    if (error && typeof error === 'object' && 'type' in error
      && typeof error.type === 'string' && /^(entity|encoding|charset|request)\./.test(error.type)) {
      sendError(request, response, new ApiError(400, 'VALIDATION_FAILED'));
      return;
    }
    next(error);
  });
  app.useGlobalFilters(new HttpErrorFilter());
  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    exceptionFactory: () => new ApiError(400, 'VALIDATION_FAILED'),
  }));
  return app;
}
