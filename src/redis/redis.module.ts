import { Global, Module } from '@nestjs/common';
import type { DynamicModule, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import type { RuntimeConfig } from '../platform/config.js';
import { RedisStore } from './client.js';

export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');

@Global()
@Module({})
export class RedisModule implements OnModuleInit, OnApplicationShutdown {
  constructor(private readonly redis: RedisStore) {}

  static configure(config: RuntimeConfig): DynamicModule {
    return {
      module: RedisModule,
      providers: [
        { provide: RUNTIME_CONFIG, useValue: config },
        { provide: RedisStore, useFactory: () => new RedisStore(config) },
      ],
      exports: [RUNTIME_CONFIG, RedisStore],
    };
  }

  onModuleInit() {
    // Export mode never initializes the Nest HTTP lifecycle.
    this.redis.start();
  }

  onApplicationShutdown() {
    this.redis.close();
  }
}
