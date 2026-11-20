import { readFile } from 'node:fs/promises';
import { readConfig } from '../src/platform/config.js';
import { log, startupFailed } from '../src/platform/log.js';
import { RedisStore } from '../src/redis/client.js';

export async function loadLibrary(redis: RedisStore, source?: string) {
  const code = source ?? await readFile(new URL('../../redis/functions/sprinthub.lua', import.meta.url), 'utf8');
  const name = await redis.mutate((client) => client.functionLoad(code, { REPLACE: true }));
  if (name !== 'sprinthub' || !await redis.ready()) throw new Error('Unexpected library name or version');
}

async function main() {
  const redis = new RedisStore(readConfig('maintenance'), 'maintenance');
  try {
    await redis.client.connect();
    await loadLibrary(redis);
    log('info', 'redis_library_loaded', { version: redis.config.libVersion });
  } finally {
    redis.close();
  }
}

if (import.meta.main) await main().catch((error: unknown) => startupFailed('maintenance', error));
