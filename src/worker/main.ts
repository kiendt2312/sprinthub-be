import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readConfig } from '../platform/config.js';
import { log, nestLogger, startupFailed } from '../platform/log.js';
import { RedisStore } from '../redis/client.js';
import { RedisModule } from '../redis/redis.module.js';

async function main() {
  const config = readConfig('worker');

  @Module({ imports: [RedisModule.configure(config)] })
  class WorkerModule {}

  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: nestLogger, abortOnError: false });
  const redis = app.get(RedisStore);
  let previous: boolean | undefined;
  const probe = async () => {
    const ready = await redis.ready();
    if (previous !== ready) log(ready ? 'info' : 'warn', ready ? 'worker_ready' : 'worker_not_ready');
    previous = ready;
  };
  const interval = setInterval(() => void probe(), 1000);
  void probe();

  const shutdown = async () => {
    clearInterval(interval);
    const timeout = setTimeout(() => process.exit(1), config.shutdownMs).unref();
    await app.close();
    clearTimeout(timeout);
    log('info', 'worker_shutdown');
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

await main().catch((error: unknown) => startupFailed('worker', error));
