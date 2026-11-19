import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { ClientClosedError, SocketClosedUnexpectedlyError, createClient } from "redis";
import { createRedisClient, DEFAULT_REDIS_URL } from "../src/client.js";
import { createTask, type CreateTaskInput } from "../src/functions.js";
import { createKeys } from "../src/keys.js";
import { decodeReply, type FunctionReply } from "../src/reply.js";
import { accepted, assertFindings, scopedKeys, type Client } from "./lib.js";
import { docker, getSpikeContainerId, waitForRedis } from "./persistence-docker.js";

const MODES = ["always", "everysec"] as const;
const TRIALS_PER_MODE = 3;
const PRE_KILL_ACKS = 400;
const WORKERS = 32;
const PROJECTS = 40;
const COLUMN_LIMIT = 500;

type FsyncMode = typeof MODES[number];
type Keys = ReturnType<typeof createKeys>;
type Ack = Extract<FunctionReply, { ok: true }>;

interface Attempt {
  input: CreateTaskInput;
  ack?: Ack;
}

async function seedFixture(client: Client, keys: Keys) {
  const id = randomUUID();
  const workspaceId = `ws_${id}`;
  const ownerId = `usr_${id}_owner`;
  const assigneeId = `usr_${id}_member`;
  const projects = Array.from({ length: PROJECTS }, (_, index) => ({
    id: `prj_${id}_${index}`,
    key: `CRASH${index}`,
  }));
  const batch = client.multi()
    .json.set(keys.workspace(workspaceId), "$", { id: workspaceId, ownerId })
    .hSet(keys.workspaceMembers(workspaceId), { [ownerId]: "OWNER", [assigneeId]: "MEMBER" });
  for (const project of projects) {
    batch.json.set(keys.project(project.id), "$", {
      id: project.id, workspaceId, key: project.key, archivedAt: null,
    });
  }
  await batch.exec();
  return { workspaceId, ownerId, assigneeId, projects };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;
type Log = (row: object) => void;

function isDisconnect(error: unknown) {
  return error instanceof SocketClosedUnexpectedlyError || error instanceof ClientClosedError ||
    (error instanceof Error && ["ECONNRESET", "EPIPE"].includes((error as NodeJS.ErrnoException).code ?? ""));
}

async function writeUntilCrash(containerId: string, keys: Keys, fixture: Fixture, log: Log) {
  const clients = Array.from({ length: WORKERS }, () => createClient({
    url: DEFAULT_REDIS_URL,
    disableOfflineQueue: true,
    socket: { reconnectStrategy: false, connectTimeout: 5_000, socketTimeout: 5_000 },
  }).on("error", () => { /* Awaited commands surface connection errors. */ }));
  const attempts = new Map<string, Attempt>();
  const latencies: number[] = [];
  let pendingAtKillRequest = 0;
  let kill: Promise<void> | undefined;
  let failure: unknown;
  let restartToPongMs = 0;

  async function write(client: typeof clients[number]) {
    while (!failure) {
      assert(attempts.size < PROJECTS * COLUMN_LIMIT, "Trial filled every TODO column before Redis disconnected");
      const project = fixture.projects[attempts.size % PROJECTS]!;
      const input = {
        workspaceId: fixture.workspaceId,
        projectId: project.id,
        actorId: fixture.ownerId,
        assigneeId: fixture.assigneeId,
        taskId: `tsk_${randomUUID()}`,
        idempotencyKey: randomUUID(),
        clientMutationId: randomUUID(),
        nowMs: Date.now(),
        payload: { title: "Crash persistence workload" },
      };
      const row: Attempt = { input };
      attempts.set(input.taskId, row);
      log({ kind: "sent", taskId: input.taskId, projectId: input.projectId, idempotencyKey: input.idempotencyKey });
      const started = performance.now();
      const operation = createTask(client, input, keys);
      if (!kill && latencies.length === PRE_KILL_ACKS) {
        pendingAtKillRequest = attempts.size - latencies.length;
        log({ kind: "kill-request", pendingAtKillRequest, sent: attempts.size, acked: latencies.length });
        kill = docker("kill", "-s", "KILL", containerId).then(() => {}, error => { failure ??= error; });
      }
      try {
        row.ack = accepted(await operation);
      } catch (error) {
        if (!kill || !isDisconnect(error)) throw error;
        log({ kind: "disconnect", taskId: input.taskId });
        return;
      }
      const elapsedMs = performance.now() - started;
      latencies.push(elapsedMs);
      log({ kind: "ack", taskId: input.taskId, elapsedMs, seq: row.ack.seq });
    }
  }

  try {
    // Wait for all connection attempts so cleanup can close every opened socket.
    const connections = await Promise.allSettled(clients.map(client => client.connect()));
    const failed = connections.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    await Promise.all(clients.map(client => write(client).catch(error => { failure ??= error; })));
  } finally {
    for (const client of clients) {
      if (client.isOpen) client.destroy();
    }
    if (kill) {
      await kill;
      const started = performance.now();
      await docker("start", containerId);
      await waitForRedis();
      restartToPongMs = performance.now() - started;
    }
  }

  if (failure) throw failure;
  assert(kill && pendingAtKillRequest > 0, "The crash must be requested while writes are pending");
  assert(attempts.size > latencies.length, "Redis disconnected without leaving any request unacknowledged");
  return { attempts, latencies, pendingAtKillRequest, restartToPongMs };
}

async function verifyRecovery(client: Client, keys: Keys, fixture: Fixture, attempts: Map<string, Attempt>) {
  await assertFindings(client, keys, []);
  const workspaceChanges = keys.workspaceChanges(fixture.workspaceId);
  const stream = await client.xRange(keys.domainEvents(), "-", "+");
  const events = new Map((stream ?? []).map(({ message }) => [message.taskId, message]));
  const projectKeys = new Map(fixture.projects.map(project => [project.id, project.key]));
  const projectCounts = new Map(fixture.projects.map(project => [project.id, 0]));
  const recoveredIds = new Set<string>();
  let recoveredWithoutAck = 0;
  let lostAcknowledgements = 0;

  for (const { input, ack } of attempts.values()) {
    const { taskId, projectId, workspaceId, actorId, idempotencyKey } = input;
    const idemKey = keys.idempotency(actorId, idempotencyKey);
    const [doc, idem, changeSeq] = await Promise.all([
      client.json.get(keys.task(taskId)), client.get(idemKey), client.zScore(workspaceChanges, `task:${taskId}`),
    ]);
    const event = events.get(taskId);
    if (doc === null) {
      if (ack) lostAcknowledgements++;
      assert.equal(idem, null, `Idempotency without task ${taskId}`);
      assert.equal(changeSeq, null, `Workspace change without task ${taskId}`);
      assert.equal(event, undefined, `Domain event without task ${taskId}`);
      continue;
    }
    const task = doc as Record<string, unknown>;
    assert.equal(task.id, taskId);
    assert.equal(task.workspaceId, workspaceId);
    assert.equal(task.projectId, projectId);
    assert.equal(task.status, "TODO");
    assert.equal(task.assigneeId, fixture.assigneeId);
    assert.equal(task.lastClientMutationId, input.clientMutationId);
    assert.equal(task.key, `${projectKeys.get(projectId)}-${task.number}`);
    assert.equal(task.version, 1);

    assert(idem, `Missing idempotency record for ${taskId}`);
    const stored = JSON.parse(idem) as { requestHash: string; response: string };
    assert.match(stored.requestHash, /^[0-9a-f]{64}$/);
    assert((await client.pTTL(idemKey)) > 0, `Invalid idempotency expiry for ${taskId}`);
    const expectedAck = { ok: true, data: task, seq: task.lastSeq };
    assert.deepEqual(decodeReply(stored.response), expectedAck);
    if (ack) assert.deepEqual(ack, expectedAck);

    assert.equal(changeSeq, task.lastSeq);
    assert(event, `Missing domain event for ${taskId}`);
    assert.equal(event.type, "TASK_CREATED");
    assert.equal(event.eventId, `${workspaceId}:${task.lastSeq}`);
    assert.equal(event.seq, String(task.lastSeq));
    assert.equal(event.workspaceId, workspaceId);
    assert.equal(event.projectId, projectId);
    assert.equal(event.actorId, actorId);
    assert.equal(event.clientMutationId, input.clientMutationId);
    assert.deepEqual(JSON.parse(event.payload!), { key: task.key });

    recoveredIds.add(taskId);
    projectCounts.set(projectId, projectCounts.get(projectId)! + 1);
    if (!ack) recoveredWithoutAck++;
  }

  const recovered = recoveredIds.size;
  const names = await scopedKeys(client, keys);
  assert.equal(names.filter(name => name.startsWith(`${keys.prefix}task:`)).length, recovered);
  assert.equal(names.filter(name => name.startsWith(`${keys.prefix}idempotency:`)).length, recovered);
  assert.equal(stream?.length ?? 0, recovered, "Unexpected domain events, including duplicates");
  assert.equal(await client.zCard(workspaceChanges), recovered);
  assert.deepEqual(new Set(await client.sMembers(keys.userAssigned(fixture.assigneeId))), recoveredIds);
  assert.equal(await client.get(keys.workspaceSeq(fixture.workspaceId)), recovered ? String(recovered) : null);
  for (const project of fixture.projects) {
    const count = projectCounts.get(project.id)!;
    assert.equal(await client.get(keys.projectTaskSeq(project.id)), count ? String(count) : null);
  }
  return { recovered, recoveredWithoutAck, lostAcknowledgements };
}

function p99(latencies: number[]) {
  assert(latencies.length > 0);
  const sorted = [...latencies].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.99) - 1]!;
}

async function runTrial(mode: FsyncMode, trial: number, containerId: string, logPath: string) {
  const keys = createKeys(`sh:spike-crash:${randomUUID()}:`);
  const log: Log = row => appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`, "utf8");
  const setup = createRedisClient();
  await setup.connect();
  let fixture: Fixture;
  try {
    await setup.configSet({ appendfsync: mode });
    const config = await setup.configGet(["appendonly", "appendfsync", "no-appendfsync-on-rewrite"]);
    assert.equal(config.appendonly, "yes");
    assert.equal(config.appendfsync, mode);
    assert.equal(config["no-appendfsync-on-rewrite"], "no");
    log({ kind: "trial-start", mode, trial, config, workers: WORKERS, projects: PROJECTS, preKillAcks: PRE_KILL_ACKS });
    fixture = await seedFixture(setup, keys);
  } finally {
    await setup.close();
  }

  try {
    const { attempts, latencies, pendingAtKillRequest, restartToPongMs } = await writeUntilCrash(containerId, keys, fixture, log);
    const client = createRedisClient();
    await client.connect();
    try {
      const recovery = await verifyRecovery(client, keys, fixture, attempts);
      const result = {
        mode, trial, sent: attempts.size, acked: latencies.length,
        pendingAtKillRequest, sentWithoutAck: attempts.size - latencies.length,
        ...recovery,
        p99ClientMs: p99(latencies.slice(0, PRE_KILL_ACKS)),
        fullRunP99ClientMs: p99(latencies),
        restartToPongMs,
      };
      log({ kind: "summary", ...result });
      console.log(JSON.stringify(result));
      if (mode === "always") assert.equal(recovery.lostAcknowledgements, 0, "appendfsync=always lost an ACKed task");
      return result;
    } finally {
      await client.close();
    }
  } finally {
    const cleanup = createRedisClient();
    try {
      await cleanup.connect();
      const names = await scopedKeys(cleanup, keys);
      if (names.length) await cleanup.unlink(names);
    } finally {
      if (cleanup.isOpen) await cleanup.close();
    }
  }
}

function range(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  // Each mode has exactly three trials.
  return { min: sorted[0], median: sorted[1], max: sorted[2] };
}

async function main() {
  const containerId = await getSpikeContainerId();
  const logDir = join(import.meta.dirname, "..", "logs", "crash-logs");
  mkdirSync(logDir, { recursive: true });
  const runDir = mkdtempSync(join(logDir, "run-"));
  console.log(`4.2 NDJSON: ${runDir}. p99 uses the first ${PRE_KILL_ACKS} ACKs per trial, before the kill request.`);
  for (const mode of MODES) {
    const trials = [];
    for (let trial = 1; trial <= TRIALS_PER_MODE; trial++) {
      trials.push(await runTrial(mode, trial, containerId, join(runDir, `${mode}-${trial}.ndjson`)));
    }
    console.log(`${mode} summary ${JSON.stringify({
      p99ClientMs: range(trials.map(row => row.p99ClientMs)),
      pendingAtKillRequest: range(trials.map(row => row.pendingAtKillRequest)),
      sentWithoutAck: range(trials.map(row => row.sentWithoutAck)),
      recoveredWithoutAck: range(trials.map(row => row.recoveredWithoutAck)),
      lostAcknowledgements: range(trials.map(row => row.lostAcknowledgements)),
      restartToPongMs: range(trials.map(row => row.restartToPongMs)),
    })}`);
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error("4.2 crash persistence failed:", error);
    process.exitCode = 1;
  });
}
