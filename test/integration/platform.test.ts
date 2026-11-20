import 'reflect-metadata';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Body, Controller, Module, Post } from '@nestjs/common';
import { IsString } from 'class-validator';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApi } from '../../src/api/app.js';
import { readConfig } from '../../src/platform/config.js';
import { RedisStore } from '../../src/redis/client.js';
import { createTask, moveTask, removeMember } from '../../src/redis/functions.js';
import { createKeys } from '../../src/redis/keys.js';
import { loadLibrary } from '../../scripts/load-library.js';
import { connected, integrationStore, redisProxy, waitForRedisData } from '../support/redis.js';

const exec = promisify(execFile);

class FixtureDto {
  @IsString() value!: string;
}

@Controller('_test')
class FixtureController {
  constructor(private readonly store: RedisStore) {}

  @Post('validate')
  validate(@Body() dto: FixtureDto) {
    return dto;
  }

  @Post('oom')
  async oom() {
    await this.store.mutate((client) => client.set(this.store.keys.projectTaskSeq('fixture-oom'), '1'));
  }
}

@Module({})
class FixtureModule {}

function fixtureModule() {
  return { module: FixtureModule, controllers: [FixtureController] };
}

describe('platform on Redis', () => {
  let maint: RedisStore;
  let runtime: RedisStore;
  let app: NestExpressApplication;
  let url: string;

  beforeAll(async () => {
    maint = await connected();
    runtime = await connected(integrationStore('api'));
    await loadLibrary(maint);
    app = await createApi(readConfig('api'), [fixtureModule()]);
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    await vi.waitFor(async () => expect((await fetch(url + '/health/ready')).status).toBe(200));
  });

  afterAll(async () => {
    await app?.close();
    runtime?.close();
    maint?.close();
  });

  async function seedWorkspace() {
    const id = randomUUID();
    const actorId = 'usr_' + id;
    const userId = 'usr_member_' + id;
    const taskId = 'tsk_' + id;
    const workspaceId = 'ws_' + id;
    const projectId = 'prj_' + id;
    const keys = runtime.keys;
    await maint.client.multi()
      .json.set(keys.workspace(workspaceId), '$', { id: workspaceId, ownerId: actorId })
      .json.set(keys.project(projectId), '$', { id: projectId, key: 'P0', workspaceId, archivedAt: null })
      .hSet(keys.workspaceMembers(workspaceId), { [actorId]: 'OWNER', [userId]: 'MEMBER' })
      .sAdd(keys.userWorkspaces(userId), workspaceId)
      .exec();
    const common = {
      workspaceId, actorId, nowMs: Date.now(), requestId: 'req_' + id,
      clientMutationId: id, idempotencyKey: 'create-' + id,
    };
    return { common, keys, id, workspaceId, projectId, actorId, userId, taskId,
      input: { ...common, projectId, taskId, payload: { title: 'Fixture' } } };
  }

  it('T-017 checks Redis 8.10.3, JSON and persistence settings with restricted runtime ACLs', async () => {
    const info = await maint.client.info('server');
    expect(info).toMatch(/^redis_version:8\.10\.3\r?$/m);
    const config = await maint.client.configGet([
      'appendonly', 'appendfsync', 'no-appendfsync-on-rewrite', 'aof-timestamp-enabled',
      'aof-load-truncated', 'save', 'maxmemory-policy', 'maxmemory',
    ]);
    expect(config).toEqual({
      appendonly: 'yes', appendfsync: 'always', 'no-appendfsync-on-rewrite': 'no', 'aof-timestamp-enabled': 'yes',
      'aof-load-truncated': 'yes', save: '900 1', 'maxmemory-policy': 'noeviction', maxmemory: '536870912',
    });
    const { keys } = runtime;
    const key = keys.task('platform-json-' + randomUUID());
    try {
      await maint.client.json.set(key, '$', { foo: true });
      expect(await runtime.client.json.get(key)).toEqual({ foo: true });
    } finally {
      await maint.client.del(key);
    }
    const worker = await connected(integrationStore('worker'));
    try {
      const probe = 'platform-project-' + randomUUID();
      expect(await runtime.client.sMembers(keys.workspaceProjects(probe))).toEqual([]);
      expect(await runtime.client.zRange(keys.workspaceProjectsPage(probe), '-', '+', { BY: 'LEX' })).toEqual([]);
      expect(await runtime.client.get(keys.projectKey(probe, 'P0'))).toBe(null);
      expect(await runtime.client.zRange(keys.backlog(probe), 0, 0)).toEqual([]);
      await expect(worker.client.zRange(keys.backlog(probe), 0, 0)).rejects.toThrow(/NOPERM/);
      for (const store of [runtime, worker]) {
        for (const command of [['FLUSHALL'], ['KEYS', '*'], ['SCAN', '0'], ['CONFIG', 'GET', 'save'],
          ['FUNCTION', 'LOAD', 'unused']]) {
          await expect(store.client.sendCommand(command)).rejects.toThrow(/NOPERM/);
        }
        expect(await store.ready()).toBe(true);
      }
    } finally {
      worker.close();
    }
  });

  it('responds with public health and marks a missing or incompatible library unready', async () => {
    const verify = async (path: string, status: number, expected: object) => {
      const response = await fetch(url + path);
      const requestId = response.headers.get('x-request-id');
      expect(requestId).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(response.status).toBe(status);
      expect(response.headers.get('server-timing')).toMatch(/^app;dur=\d+\.\d{3}$/);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ ...expected, requestId });
    };
    await verify('/health/live', 200, { status: 'ok' });
    await verify('/health/ready', 200, { status: 'ok' });
    const unavailable = { error: { code: 'SERVICE_NOT_READY', params: {} } };
    try {
      await maint.client.functionDelete('sprinthub');
      await verify('/health/ready', 503, unavailable);
      const source = await readFile('redis/functions/sprinthub.lua', 'utf8');
      await maint.client.functionLoad(source.replace(/local LIB_VERSION = \d+/, 'local LIB_VERSION = 999'));
      await verify('/health/live', 200, { status: 'ok' });
      await verify('/health/ready', 503, unavailable);
    } finally {
      await loadLibrary(maint);
    }
    await verify('/health/ready', 200, { status: 'ok' });
  });

  it('T-019 returns correlated validation/OOM envelopes without reflecting input or Redis details', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const request = (path: string, body: string) => fetch(url + '/_test/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    try {
      const responses = [await request('validate', '{"value":"ok","password":"test-redact"}'),
        await request('validate', '{bad-json')];
      await maint.client.configSet('maxmemory', '1');
      responses.push(await request('oom', '{}'));
      for (const [index, response] of responses.entries()) {
        const oom = index === 2;
        const requestId = response.headers.get('x-request-id');
        expect(response.status).toBe(oom ? 503 : 400);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('server-timing')).toMatch(/^app;dur=/);
        expect(await response.json()).toEqual({
          error: { code: oom ? 'REDIS_UNAVAILABLE' : 'VALIDATION_FAILED', params: {} }, requestId,
        });
        if (oom) expect(write.mock.calls.flat().join(' ')).toContain(String(requestId));
      }
      expect(write.mock.calls.flat().join(' ')).not.toMatch(/test-redact|fixture-oom|OOM command/);
    } finally {
      await maint.client.configSet('maxmemory', '512mb');
      write.mockRestore();
    }
  });

  it('reports invalid env and exits for API and worker without logging credentials', async () => {
    for (const [role, key] of [['api', 'REDIS_APP_URL'], ['worker', 'REDIS_WORKER_URL']]) {
      await expect(exec(process.execPath, [`dist/src/${role}/main.js`], {
        env: { ...process.env, [key]: 'bad-url-private-credential' },
      })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringMatching(new RegExp(`"variable":"${key}"`)),
      });
    }
  });

  it('retains original event, data and sequence when each updated task wrapper is replayed', async () => {
    const fixture = await seedWorkspace();
    const { input, common, keys, id, projectId, taskId, userId, workspaceId } = fixture;
    const operation = [
      [() => createTask(runtime, input), () => createTask(runtime, { ...input, requestId: 'req_replay' })],
      [() => moveTask(runtime, { ...common, taskId, projectId, from: 'TODO', to: 'IN_PROGRESS',
        expectedVersion: 1, idempotencyKey: 'move-' + id }),
      () => moveTask(runtime, { ...common, taskId, projectId, from: 'IN_PROGRESS', to: 'IN_PROGRESS',
        expectedVersion: 1, idempotencyKey: 'move-' + id, requestId: 'req_replay' })],
      [() => removeMember(runtime, { ...common, userId, idempotencyKey: 'remove-' + id }),
      () => removeMember(runtime, { ...common, userId, idempotencyKey: 'remove-' + id, requestId: 'req_replay' })],
    ];
    for (const [run, replay] of operation) {
      const original = await run();
      expect(original.ok).toBe(true);
      expect(await replay()).toEqual(original);
    }
    const events = (await maint.client.xRange(keys.domainEvents(), '-', '+'))!
      .map((entry) => entry.message).filter((event) => event.workspaceId === workspaceId);
    expect(events.map((event) => [event.type, event.eventId, event.requestId])).toEqual(
      ['TASK_CREATED', 'TASK_MOVED', 'MEMBER_REMOVED'].map((type, i) => [type, `${workspaceId}:${i + 1}`, common.requestId]),
    );
  });

  it('leaves committed mutations alone after losing a reply and replays once with the same key', async () => {
    const { input, keys, workspaceId } = await seedWorkspace();
    const proxy = await redisProxy(runtime.config.redisUrl);
    const store = new RedisStore({ ...runtime.config, redisUrl: proxy.url });
    try {
      await connected(store);
      proxy.trap('sh_create_task');
      await expect(createTask(store, input)).rejects.toMatchObject({ code: 'MUTATION_OUTCOME_UNKNOWN' });
      expect(proxy.count).toBe(1);
      expect(await maint.client.get(keys.workspaceSeq(workspaceId))).toBe('1');
      const previous = JSON.parse((await maint.client.get(keys.idempotency(input.actorId, input.idempotencyKey)))!);
      expect(await createTask(runtime, { ...input, requestId: 'req_retry' })).toEqual(JSON.parse(previous.response));
      expect(await maint.client.get(keys.workspaceSeq(workspaceId))).toBe('1');
    } finally {
      store.close();
      await proxy.close();
    }
  });

  it('fails fast offline, retries transient reads twice, and bounds KEYS_MISMATCH rereads', async () => {
    const offline = new RedisStore(runtime.config);
    await expect(offline.mutate((client) => client.ping())).rejects.toMatchObject({ code: 'REDIS_UNAVAILABLE' });
    const proxy = await redisProxy(runtime.config.redisUrl);
    const store = new RedisStore({ ...runtime.config, redisUrl: proxy.url });
    try {
      await connected(store);
      proxy.trap('GET', '-LOADING Loading dataset\r\n');
      await expect(store.read((client) => client.get(runtime.keys.task('nonexistent'))))
        .rejects.toMatchObject({ code: 'REDIS_UNAVAILABLE' });
      expect(proxy.count).toBe(3);
      proxy.trap('UNUSED');
      expect(await store.read((client) => client.get(runtime.keys.task('nonexistent')))).toBeNull();
      let attempts = 0;
      await expect(store.withKeySnapshot(async (deadline) => {
        attempts++;
        return store.call('sh_create_task', [], [], deadline);
      })).rejects.toMatchObject({ code: 'REDIS_UNAVAILABLE' });
      expect(attempts).toBe(3);
    } finally {
      store.close();
      await proxy.close();
    }
  });
});

describe('Compose lifecycle', () => {
  it('preserves task, outbox, index, idempotency and library across restart and regains readiness', async () => {
    const maint = await connected();
    const app = await createApi(readConfig('api'));
    const worker = spawn(process.execPath, ['dist/src/worker/main.js'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const workerExit = once(worker, 'exit');
    let workerOutput = '';
    worker.stdout.on('data', (buffer: Buffer) => { workerOutput += buffer.toString(); });
    const { client } = maint;
    const id = randomUUID();
    // The verifier scans its entire key prefix. Keep the persisted fixture in its own namespace.
    const keys = createKeys(`${maint.keys.prefix}lifecycle:${id}:`);
    const workspaceId = 'ws_' + id;
    const projectId = 'prj_' + id;
    const actorId = 'usr_' + id;
    const taskId = 'tsk_' + id;
    const key = 'restart-' + id;
    const state = async () => ({
      task: await client.json.get(keys.task(taskId)),
      issue: await client.hGet(keys.workspaceTaskKeys(workspaceId), 'RE-1'),
      order: await client.zRangeWithScores(keys.board(projectId, 'TODO'), 0, -1),
      tasks: await client.sMembers(keys.projectTasks(projectId)),
      events: await client.xRange(keys.domainEvents(), '-', '+'),
      idempotency: await client.get(keys.idempotency(actorId, key)),
      version: await client.fCallRo('sh_lib_version'),
    });
    try {
      // Match the live Redis run ID to the Compose service before stopping it.
      const compose = (...args: string[]) => exec('docker', ['compose', ...args], { timeout: 30_000 });
      const info = await compose('exec', '-T', 'redis', 'sh', '-c',
        'REDISCLI_AUTH="$REDIS_MAINT_PASSWORD" redis-cli --user sh-maint INFO server');
      const runId = /^run_id:([^\s]+)/m.exec(info.stdout)?.[1];
      expect(runId).toBeTruthy();
      expect(await client.info('server')).toContain(`run_id:${runId}`);
      const config = await compose('config', '--images', 'redis');
      const container = (await compose('ps', '-q', 'redis')).stdout.trim();
      const image = (await exec('docker', ['inspect', '--format', '{{.Config.Image}}', container])).stdout.trim();
      expect(image).toBe(config.stdout.trim());
      expect(image).toMatch(/redis:8\.10\.3@sha256:[a-f0-9]{64}$/);
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      await vi.waitFor(async () => expect((await fetch(base + '/health/ready')).status).toBe(200));
      await client.json.set(keys.project(projectId), '$', { id: projectId, key: 'RE', workspaceId, archivedAt: null });
      await client.hSet(keys.workspaceMembers(workspaceId), actorId, 'OWNER');
      expect((await createTask(maint, {
        workspaceId, projectId, actorId, taskId, nowMs: Date.now(), idempotencyKey: key,
        clientMutationId: id, requestId: 'req_' + id, payload: { title: 'Restart' },
      }, keys)).ok).toBe(true);
      const before = await state();
      await vi.waitFor(() => expect(workerOutput).toContain('"event":"worker_ready"'), { timeout: 4000 });
      workerOutput = '';
      expect(before.order).toEqual([{ value: taskId, score: 1024 }]);
      expect(before.events).toHaveLength(1);
      await compose('stop', 'redis');
      try {
        expect((await fetch(base + '/health/live')).status).toBe(200);
        expect((await fetch(base + '/health/ready')).status).toBe(503);
        await vi.waitFor(() => expect(workerOutput).toContain('"event":"worker_not_ready"'), { timeout: 4000 });
      } finally {
        await compose('up', '-d', '--wait', 'redis');
      }
      await vi.waitFor(async () => expect((await fetch(base + '/health/ready')).status).toBe(200), { timeout: 20_000 });
      await waitForRedisData(maint);
      expect(await state()).toEqual(before);
      await vi.waitFor(() => expect(workerOutput).toContain('"event":"worker_ready"'), { timeout: 4000 });
      const { verifyTaskIndexes } = await import('../../scripts/verify-task-indexes.js');
      expect(await verifyTaskIndexes(client, keys, { legacy: true })).toEqual({ ok: true, findings: [] });
    } finally {
      await app.close();
      worker.kill('SIGTERM');
      const deadline = setTimeout(() => worker.kill('SIGKILL'), 7000);
      try {
        expect(await workerExit).toEqual([0, null]);
        expect(workerOutput).toContain('"event":"worker_shutdown"');
      } finally {
        clearTimeout(deadline);
        try {
          await client.unlink([
            keys.project(projectId), keys.workspaceMembers(workspaceId), keys.task(taskId),
            keys.workspaceTaskKeys(workspaceId), keys.board(projectId, 'TODO'), keys.projectTasks(projectId),
            keys.projectTaskSeq(projectId), keys.domainEvents(), keys.workspaceSeq(workspaceId),
            keys.workspaceChanges(workspaceId), keys.idempotency(actorId, key),
          ]);
        } finally {
          maint.close();
        }
      }
    }
  }, 45_000);
});
