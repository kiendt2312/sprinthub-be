import { describe, expect, it } from 'vitest';
import { ConfigError, readConfig } from '../../src/platform/config.js';
import { createKeys } from '../../src/redis/keys.js';
import { decodeReply } from '../../src/redis/reply.js';
import { makeId } from '../../src/platform/http/request.js';

const apiEnv = {
  REDIS_APP_URL: 'redis://sh-app:placeholder@localhost',
  AUTH_ORIGIN: 'http://localhost:3000',
  AUTH_IP_HMAC_SECRET: 'a'.repeat(32),
};

describe('runtime configuration', () => {
  it('uses separate credentials for each process', () => {
    expect(readConfig('api', apiEnv)).toMatchObject({ prefix: 'sh:v1:', port: 3000, timeoutMs: 200 });
    expect(() => readConfig('worker', apiEnv)).toThrow(ConfigError);
    expect(() => readConfig('worker', { REDIS_WORKER_URL: apiEnv.REDIS_APP_URL })).toThrow(ConfigError);
    expect(readConfig('worker', { REDIS_WORKER_URL: 'rediss://sh-worker:placeholder@localhost' }).role).toBe('worker');
  });

  it('defaults worker unassign batches to 50 and accepts overrides from 1 to 100', () => {
    const workerEnv = { REDIS_WORKER_URL: 'redis://sh-worker:placeholder@localhost' };
    expect(readConfig('worker', workerEnv).unassignBatchSize).toBe(50);
    for (const size of [1, 100]) {
      expect(readConfig('worker', { ...workerEnv, UNASSIGN_BATCH_SIZE: String(size) }).unassignBatchSize).toBe(size);
    }
    for (const value of ['0', '101', '1.5', '']) {
      expect(() => readConfig('worker', { ...workerEnv, UNASSIGN_BATCH_SIZE: value }))
        .toThrow(expect.objectContaining({ variable: 'UNASSIGN_BATCH_SIZE' }));
    }
  });

  it.each([
    { REDIS_TIMEOUT_MS: '0' }, { API_PORT: '65536' }, { API_PORT: '1e3' },
    { REDIS_LIB_VERSION: '-1' }, { REDIS_LIB_VERSION: '999' },
    { AUTH_ORIGIN: 'https://example.test/path' }, { AUTH_IP_HMAC_SECRET: 'short' },
    { AUTH_TRUSTED_PROXIES: '0.0.0.0/0' }, { AUTH_SESSION_TOUCH_MS: '0' }, { REDIS_KEY_PREFIX: 'test:*' },
    { REDIS_APP_URL: 'redis://sh-app:placeholder@localhost/2' },
    { REDIS_APP_URL: 'http://sh-app:placeholder@localhost' },
  ])('rejects invalid environment %j', (override) => {
    expect(() => readConfig('api', { ...apiEnv, ...override })).toThrow(ConfigError);
  });
});

describe('Redis and request identifiers', () => {
  it('uses one configurable prefix across key families', () => {
    const keys = createKeys('sh:fixture:');
    expect(keys.task('tsk_1')).toBe('sh:fixture:task:tsk_1');
    expect(keys.projectTasks('prj_1')).toBe('sh:fixture:project-tasks:prj_1');
    expect(keys.idempotency('usr_1', 'm1')).toBe('sh:fixture:idempotency:usr_1:m1');
    expect(() => createKeys('')).toThrow();
  });

  it('decodes workspace replies and structured failures', () => {
    expect(decodeReply('{"ok":true,"data":{"version":1},"seq":2}')).toEqual({ ok: true, data: { version: 1 }, seq: 2 });
    expect(decodeReply('{"ok":false,"code":"CONFLICT","params":{"currentVersion":4}}')).toEqual({
      ok: false, code: 'CONFLICT', params: { currentVersion: 4 },
    });
    expect(decodeReply('{"ok":true,"data":{"changed":false},"seq":null}')).toEqual({
      ok: true, data: { changed: false }, seq: null,
    });
    for (const value of [null, 'bad json', '{"ok":true,"seq":1}', '{"ok":true,"data":{},"seq":1.5}',
      '{"ok":false,"code":"ERROR","params":[]}']) expect(() => decodeReply(value)).toThrow();
  });

  it('issues distinct monotonic request IDs', () => {
    const one = makeId('req');
    const two = makeId('req');
    expect(one).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(two > one).toBe(true);
  });
});
