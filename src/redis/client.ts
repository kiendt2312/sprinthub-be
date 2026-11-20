import { createClient, ErrorReply, ClientOfflineError, ClientClosedError } from 'redis';
import type { RuntimeConfig } from '../platform/config.js';
import { log } from '../platform/log.js';
import { createKeys } from './keys.js';
import { decodeReply } from './reply.js';
import { setTimeout as sleep } from 'node:timers/promises';

export type ConnectionRole = 'request' | 'subscriber' | 'blocking' | 'maintenance';

export function createRedisClient(config: RuntimeConfig, role: ConnectionRole) {
  return createClient({
    url: config.redisUrl,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: Math.min(config.timeoutMs * 5, 3000),
      reconnectStrategy: (retries) => Math.min(50 * 2 ** retries, 1000) + Math.floor(Math.random() * 50),
    },
  }).on('error', () => log('warn', 'redis_connection_error', { role: config.role, connection: role }));
}

export class RedisFailure extends Error {
  constructor(readonly code: 'REDIS_UNAVAILABLE' | 'MUTATION_OUTCOME_UNKNOWN' | 'INTERNAL_ERROR', cause?: unknown) {
    super(code, { cause });
  }
}

type Client = ReturnType<typeof createRedisClient>;

export class RedisStore {
  readonly keys: ReturnType<typeof createKeys>;
  readonly client: Client;

  constructor(readonly config: RuntimeConfig, role: ConnectionRole = 'request') {
    this.keys = createKeys(config.prefix);
    this.client = createRedisClient(config, role);
  }

  start() {
    if (!this.client.isOpen) {
      void this.client.connect().catch(() => log('warn', 'redis_connect_stopped', { role: this.config.role }));
    }
  }

  async connect() {
    const timeout = setTimeout(() => this.close(), Math.min(this.config.timeoutMs * 10, 5000));
    try {
      await this.client.connect();
    } catch (cause) {
      throw new RedisFailure('REDIS_UNAVAILABLE', cause);
    } finally {
      clearTimeout(timeout);
    }
  }

  close() {
    if (this.client.isOpen) this.client.destroy();
  }

  async #execute<T>(operation: (client: Client) => Promise<T>, deadline: number, mutation: boolean): Promise<T> {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0 || !this.client.isReady) throw new RedisFailure('REDIS_UNAVAILABLE');

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new RedisFailure(mutation ? 'MUTATION_OUTCOME_UNKNOWN' : 'REDIS_UNAVAILABLE'));
        controller.abort();
      }, remaining);
    });
    try {
      return await Promise.race([operation(this.client.withAbortSignal(controller.signal)), timeout]);
    } catch (error) {
      if (error instanceof RedisFailure) throw error;
      if (error instanceof ClientOfflineError || error instanceof ClientClosedError) {
        throw new RedisFailure('REDIS_UNAVAILABLE', error);
      }
      if (error instanceof ErrorReply) {
        const code = error.message.split(' ', 1)[0];
        if (code === 'OOM' || code === 'LOADING' || code === 'MASTERDOWN' || code === 'READONLY') {
          throw new RedisFailure('REDIS_UNAVAILABLE', error);
        }
        throw new RedisFailure('INTERNAL_ERROR', error);
      }
      throw new RedisFailure(mutation ? 'MUTATION_OUTCOME_UNKNOWN' : 'REDIS_UNAVAILABLE', error);
    } finally {
      clearTimeout(timer);
    }
  }

  deadline() {
    return performance.now() + this.config.timeoutMs;
  }

  async read<T>(operation: (client: Client) => Promise<T>, deadline = this.deadline()): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#execute(operation, deadline, false);
      } catch (error) {
        const delay = 5 * 2 ** attempt + Math.floor(Math.random() * 6);
        if (!(error instanceof RedisFailure) || error.code !== 'REDIS_UNAVAILABLE'
          || attempt === 2 || !this.client.isReady || performance.now() + delay >= deadline) throw error;
        await sleep(delay);
      }
    }
  }

  mutate<T>(operation: (client: Client) => Promise<T>, deadline = this.deadline()): Promise<T> {
    return this.#execute(operation, deadline, true);
  }

  async call(name: string, keys: string[], args: string[], deadline = this.deadline()) {
    const raw = await this.mutate((client) => client.fCall(name, { keys, arguments: args }), deadline);
    return decodeReply(raw);
  }

  async callWorkspace(name: string, keys: string[], args: string[], deadline = this.deadline()) {
    const reply = await this.call(name, keys, args, deadline);
    if (reply.ok && reply.seq === null) throw new RedisFailure('INTERNAL_ERROR');
    return reply;
  }

  async withKeySnapshot<T extends { ok: boolean; code?: string }>(
    run: (deadline: number) => Promise<T>,
    deadline = this.deadline(),
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const reply = await run(deadline);
      if (reply.ok || reply.code !== 'KEYS_MISMATCH') return reply;
    }
    throw new RedisFailure('REDIS_UNAVAILABLE');
  }

  async ready() {
    try {
      return await this.read((client) => client.fCallRo('sh_lib_version')) === this.config.libVersion;
    } catch {
      return false;
    }
  }
}
