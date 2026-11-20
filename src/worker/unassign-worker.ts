import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ErrorReply } from 'redis';
import type { RuntimeConfig } from '../platform/config.js';
import { log } from '../platform/log.js';
import { RedisFailure, RedisStore, createRedisClient } from '../redis/client.js';

const GROUP = 'unassign';
const BLOCK_MS = 1000;
const CLAIM_IDLE_MS = 30_000;
const MAX_DELIVERIES = 4;
const PAGE_SIZE = 100;
const DUE_BATCH_SIZE = 50;
const TRIM_INTERVAL_MS = 60_000;
const STREAM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STUCK_JOB_MS = 15 * 60 * 1000;

export interface UnassignWorkerOptions {
  blockMs?: number;
  claimIdleMs?: number;
  trimIntervalMs?: number;
}

type StreamEntry = { id: string; message: Record<string, string> };
type StreamBatch = Array<{ name: string; messages: StreamEntry[] }> | null;
type WorkerClient = ReturnType<typeof createRedisClient>;

function parseEvent(entry: StreamEntry) {
  const { message } = entry;
  if (message.type !== 'MEMBER_REMOVED') return null;
  let payload: unknown;
  try {
    payload = JSON.parse(message.payload ?? '');
  } catch {
    throw new Error('INVALID_MEMBER_REMOVED_PAYLOAD');
  }
  if (!payload || typeof payload !== 'object' || !('userId' in payload)
    || typeof payload.userId !== 'string' || !payload.userId) throw new Error('INVALID_MEMBER_REMOVED_PAYLOAD');
  const eventId = message.eventId ?? '';
  const separator = eventId.lastIndexOf(':');
  if (separator < 1 || !/^\d+$/.test(eventId.slice(separator + 1))) throw new Error('INVALID_MEMBER_REMOVED_EVENT');
  const workspaceId = eventId.slice(0, separator);
  if (message.workspaceId !== workspaceId || message.seq !== eventId.slice(separator + 1)) {
    throw new Error('INVALID_MEMBER_REMOVED_EVENT');
  }
  const userId = payload.userId;
  const seq = eventId.slice(separator + 1);
  return { eventId, workspaceId, userId, jobId: `unassign-${workspaceId}-${seq}` };
}

function pendingDeliveryCount(store: RedisStore, stream: string, id: string) {
  return store.read((client) => client.xPendingRange(stream, GROUP, id, id, 1))
    .then((entries) => entries[0]?.deliveriesCounter ?? 1);
}

export class UnassignWorker {
  readonly #blocking: WorkerClient;
  readonly #consumer = `${process.pid}-${randomUUID()}`;
  #stopped = false;
  #lastTrimAt = 0;
  #started = false;
  #runPromise?: Promise<void>;
  #claimCursor = '0-0';
  readonly #stuckLogged = new Set<string>();

  constructor(readonly store: RedisStore, config: RuntimeConfig, readonly options: UnassignWorkerOptions = {}) {
    this.#blocking = createRedisClient(config, 'blocking');
  }

  async start() {
    if (this.#started) return;
    this.#started = true;
    this.#blocking.connect().catch(() => undefined);
    this.#runPromise = this.#run();
  }

  async stop() {
    this.#stopped = true;
    if (this.#blocking.isOpen) this.#blocking.destroy();
    await this.#runPromise?.catch(() => undefined);
  }

  async #run() {
    const { keys } = this.store;
    while (!this.#stopped) {
      if (!this.store.client.isReady || !this.#blocking.isReady || !await this.store.ready()) {
        await sleep(100);
        continue;
      }
      try {
        await this.#bootstrap();
        if (this.#stopped) break;
        try { await this.#recoverDueJobs(); } catch { /* a bad job must not block stream progress */ }
        if (this.#stopped) break;
        try { await this.#reclaimPending(); } catch { /* retry from the current PEL cursor */ }
        if (this.#stopped) break;
        try { await this.#trimIfDue(); } catch { /* retention is retried on the next loop */ }
        if (this.#stopped) break;
        const entries = await this.#blocking.xReadGroup(GROUP, this.#consumer,
          [{ key: keys.domainEvents(), id: '>' }], { COUNT: 10, BLOCK: this.options.blockMs ?? BLOCK_MS }) as StreamBatch;
        for (const batch of entries ?? []) {
          for (const entry of batch.messages) {
            if (this.#stopped) return;
            await this.#handleEntry(entry);
          }
        }
      } catch (error) {
        if (this.#stopped) return;
        const code = error instanceof RedisFailure ? error.code : 'WORKER_REDIS_ERROR';
        log('warn', 'unassign_worker_loop_error', { code });
        await sleep(250);
      }
    }
  }

  async #bootstrap() {
    try {
      await this.store.mutate((client) => client.xGroupCreate(this.store.keys.domainEvents(), GROUP, '0-0', { MKSTREAM: true }));
    } catch (error) {
      if (!(error instanceof RedisFailure) || !(error.cause instanceof ErrorReply)
        || !error.cause.message.startsWith('BUSYGROUP')) throw error;
    }
  }

  async #handleEntry(entry: StreamEntry) {
    const { keys } = this.store;
    let event: ReturnType<typeof parseEvent>;
    try {
      event = parseEvent(entry);
    } catch (error) {
      if (this.#isTransportUnavailable(error)) return;
      await this.#recordFailure(entry);
      return;
    }
    if (!event) {
      await this.store.mutate((client) => client.xAck(keys.domainEvents(), GROUP, entry.id)).catch(() => undefined);
      return;
    }
    let persisted = false;
    try {
      const reply = await this.store.call('sh_persist_unassign_job',
        [keys.unassignJob(event.jobId), keys.unassignJobsByDue()],
        [event.jobId, event.workspaceId, event.userId, event.eventId]);
      persisted = reply.ok;
    } catch (error) {
      // A lost Function reply has an unknown outcome. A later delivery can replay persist.
      if (this.#isTransportUnavailable(error)) return;
    }
    if (!persisted) {
      await this.#recordFailure(entry);
      return;
    }
    // ACK is outside the retry/DLQ path: an ACK timeout is always recovered
    // through the PEL and dedupe marker, never treated as bad event data.
    await this.store.mutate((client) => client.xAck(keys.domainEvents(), GROUP, entry.id));
  }

  async #recordFailure(entry: StreamEntry) {
    const deliveries = await pendingDeliveryCount(this.store, this.store.keys.domainEvents(), entry.id).catch(() => 1);
    if (deliveries >= MAX_DELIVERIES) await this.#deadLetter(entry);
  }

  #isTransportUnavailable(error: unknown) {
    return (error instanceof RedisFailure
      && (error.code === 'REDIS_UNAVAILABLE' || error.code === 'MUTATION_OUTCOME_UNKNOWN'))
      || !this.store.client.isReady;
  }

  async #deadLetter(entry: StreamEntry) {
    const { keys } = this.store;
    const marker = keys.unassignDeadLetterMarker(entry.id);
    const reply = await this.store.call('sh_dead_letter_unassign',
      [keys.domainEvents(), keys.deadLetter(), marker], [entry.id]);
    if (reply.ok) {
      if (reply.data === true) log('warn', 'unassign_event_dead_lettered', { streamId: entry.id });
      await this.store.mutate((client) => client.xAck(keys.domainEvents(), GROUP, entry.id));
    }
  }

  async #reclaimPending() {
    const { keys } = this.store;
    const claimed = await this.store.mutate((client) => client.xAutoClaim(keys.domainEvents(), GROUP, this.#consumer,
      this.options.claimIdleMs ?? CLAIM_IDLE_MS, this.#claimCursor, { COUNT: 20 }));
    this.#claimCursor = claimed.nextId;
    for (const entry of claimed.messages) {
      if (this.#stopped) return;
      if (entry) await this.#handleEntry(entry as StreamEntry);
    }
  }

  async #recoverDueJobs() {
    const { keys } = this.store;
    const due = await this.store.read((redis) => redis.zRange(keys.unassignJobsByDue(), '-inf', Date.now(), {
      BY: 'SCORE', LIMIT: { offset: 0, count: DUE_BATCH_SIZE },
    }));
    for (const jobId of due) {
      if (this.#stopped) return;
      try { await this.#runJob(jobId); } catch { /* one malformed job must not starve other due work */ }
    }
  }

  async #runJob(jobId: string) {
    const { keys } = this.store;
    const value = await this.store.read((redis) => redis.json.get(keys.unassignJob(jobId)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const job = value as Record<string, unknown>;
    if (typeof job.workspaceId !== 'string' || typeof job.userId !== 'string') return;
    const workspaceId = job.workspaceId;
    const userId = job.userId;
    const createdAtMs = typeof job.createdAtMs === 'number' ? job.createdAtMs : Number(job.createdAtMs);
    if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > STUCK_JOB_MS && !this.#stuckLogged.has(jobId)) {
      if (this.#stuckLogged.size >= 1024) this.#stuckLogged.delete(this.#stuckLogged.values().next().value!);
      this.#stuckLogged.add(jobId);
      log('warn', 'unassign_job_stuck', { jobId });
    }
    const token = randomUUID();
    const scope = [keys.unassignJob(jobId), keys.unassignJobsByDue(),
      keys.unassignLock(workspaceId, userId), keys.unassignFence(workspaceId, userId)];
    const claim = await this.store.call('sh_claim_unassign_job', scope, [jobId, workspaceId, userId, token]);
    if (!claim.ok || !claim.data || typeof claim.data !== 'object') return;
    const lease = claim.data as { epoch?: number; cursor?: string };
    if (!Number.isSafeInteger(lease.epoch) || typeof lease.cursor !== 'string') return;

    let cursor = lease.cursor;
    for (let page = 0; page < 10_000 && !this.#stopped; page++) {
      const scan = await this.store.read((redis) => redis.sScan(keys.userAssigned(userId), cursor, { COUNT: PAGE_SIZE }));
      const chunks = Array.from({ length: Math.ceil(scan.members.length / PAGE_SIZE) }, (_, index) =>
        scan.members.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE));
      if (!chunks.length) chunks.push([]);
      let nextCursor = scan.cursor;
      for (const [index, taskIds] of chunks.entries()) {
        if (this.#stopped) return;
        const reply = await this.store.call('sh_run_unassign_batch',
          [...scope, keys.workspaceMembers(workspaceId), keys.userAssigned(userId), keys.workspaceSeq(workspaceId),
            keys.workspaceChanges(workspaceId), keys.domainEvents(), ...taskIds.map(keys.task)],
          [jobId, workspaceId, userId, token, String(lease.epoch), cursor,
            index === chunks.length - 1 ? nextCursor : '', ...taskIds]);
        if (!reply.ok || !reply.data || typeof reply.data !== 'object') return;
        const progress = reply.data as { done?: boolean; cursor?: string };
        if (progress.done) return;
        if (typeof progress.cursor !== 'string') return;
        nextCursor = progress.cursor;
      }
      if (nextCursor === cursor) return;
      cursor = nextCursor;
      if (cursor === '0') return;
    }
  }

  async #trimIfDue() {
    const now = Date.now();
    if (now - this.#lastTrimAt < (this.options.trimIntervalMs ?? TRIM_INTERVAL_MS)) return;
    const threshold = `${now - STREAM_RETENTION_MS}-0`;
    await this.store.mutate((client) => client.xTrim(this.store.keys.domainEvents(), 'MINID', threshold,
      { strategyModifier: '~', LIMIT: 1000, policy: 'ACKED' }));
    this.#lastTrimAt = now;
  }
}
