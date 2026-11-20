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
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { HealthController } from './health.controller.js';

@Module({})
class ApiModule {}

function safeJsonProperty(key: string, value: unknown) {
  if (key === '__proto__' || key === 'constructor') throw new SyntaxError('Invalid JSON property');
  return value;
}

const standardJson = express.json({ limit: '32kb', reviver: safeJsonProperty });
// 20,000 code points can require up to 240,000 bytes using JSON surrogate escapes.
const descriptionJson = express.json({ limit: '256kb', reviver: safeJsonProperty });

export async function createApi(config: RuntimeConfig, extraImports: DynamicModule[] = []) {
  const app = await NestFactory.create<NestExpressApplication>({
    module: ApiModule,
    imports: [RedisModule.configure(config), AuthModule, UsersModule, WorkspacesModule, ProjectsModule, TasksModule, ...extraImports],
    controllers: [HealthController],
  }, { logger: nestLogger, abortOnError: false, bodyParser: false, forceCloseConnections: false });

  app.set('trust proxy', config.trustedProxies.length ? config.trustedProxies : false);
  app.disable('x-powered-by');
  app.use(requestContext);
  app.use((request: ApiRequest, response: Response, next: NextFunction) => {
    const hasDescription = request.method === 'POST'
      ? /^\/api\/v1\/(?:workspaces\/[^/]+\/projects|projects\/[^/]+\/tasks)\/?$/i.test(request.path)
      : request.method === 'PATCH' && /^\/api\/v1\/(?:projects|tasks)\/[^/]+\/?$/i.test(request.path);
    (hasDescription ? descriptionJson : standardJson)(request, response, next);
  });
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
