import { constants } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { RedisFailure, RedisStore } from '../../src/redis/client.js';
import { readConfig } from '../../src/platform/config.js';
import { USER_ID } from '../../src/auth/auth.types.js';
import { makeId } from '../../src/platform/http/request.js';

const HOST_OPERATORS_FILE = '/etc/sprinthub/cli-operators.json';
const LOCAL_ENV_FILE = '.env.local';
const MAX_ADMINS = 16;
const MAX_SESSIONS = 32;

type Operation = 'grant' | 'revoke' | 'suspend' | 'reactivate' | 'revoke-sessions' | 'registration';
type Mapping = Record<string, string>;

class CliError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function parseOperatorMapping(raw: string): Mapping {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new CliError('OPERATOR_FORBIDDEN'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliError('OPERATOR_FORBIDDEN');
  const result: Mapping = Object.create(null) as Mapping;
  for (const [osUser, userId] of Object.entries(value)) {
    if (!osUser || typeof userId !== 'string' || !USER_ID.test(userId)) {
      throw new CliError('OPERATOR_FORBIDDEN');
    }
    result[osUser] = userId;
  }
  return result;
}

async function operatorIdentity(local: boolean, env: NodeJS.ProcessEnv): Promise<{ osUser: string; userId: string }> {
  let osUser: string;
  try { osUser = userInfo().username; } catch { throw new CliError('OPERATOR_FORBIDDEN'); }
  if (!osUser) throw new CliError('OPERATOR_FORBIDDEN');
  let mapping: Mapping;
  if (local) {
    const path = resolve(LOCAL_ENV_FILE);
    let fileEnv: NodeJS.ProcessEnv;
    try { fileEnv = parseEnv(await readFile(path, 'utf8')); } catch { throw new CliError('OPERATOR_FORBIDDEN'); }
    const raw = fileEnv.SPRINT_HUB_CLI_OPERATORS_JSON;
    if (!raw) throw new CliError('OPERATOR_FORBIDDEN');
    mapping = parseOperatorMapping(raw);
    Object.assign(env, fileEnv);
  } else {
    const parent = await stat('/etc/sprinthub').catch(() => undefined);
    if (!parent || parent.uid !== 0 || (parent.mode & 0o022) !== 0 || !parent.isDirectory()) {
      throw new CliError('OPERATOR_FORBIDDEN');
    }
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(HOST_OPERATORS_FILE, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { throw new CliError('OPERATOR_FORBIDDEN'); }
    try {
      const info = await file.stat();
      if (info.uid !== 0 || (info.mode & 0o022) !== 0 || !info.isFile()) throw new CliError('OPERATOR_FORBIDDEN');
      mapping = parseOperatorMapping(await file.readFile('utf8'));
    } finally { await file.close(); }
  }
  const userId = mapping[osUser];
  if (!userId) throw new CliError('OPERATOR_FORBIDDEN');
  return { osUser, userId };
}

export function parseAdminArgs(args: string[]): { local: boolean; operation: Operation; target?: string; setting?: string } {
  const local = args[0] === '--local';
  const filtered = local ? args.slice(1) : args;
  const [operation, first, second, ...extra] = filtered;
  if (extra.length) throw new CliError('INVALID_ARGUMENT');
  if (!['grant', 'revoke', 'suspend', 'reactivate', 'revoke-sessions', 'registration'].includes(operation ?? '')) {
    throw new CliError('INVALID_ARGUMENT');
  }
  if (operation === 'registration') {
    if (!['on', 'off'].includes(first ?? '') || second) throw new CliError('INVALID_ARGUMENT');
    return { local, operation, setting: first };
  }
  if (!first || !USER_ID.test(first) || second) throw new CliError('INVALID_ARGUMENT');
  return { local, operation: operation as Operation, target: first };
}

async function boundedSnapshot(redis: RedisStore, indexKey: string, maximum: number, name: string, deadline: number): Promise<string[]> {
  const members = await redis.read(async client => {
    const count = await client.sCard(indexKey);
    if (count > maximum) throw new Error(`${name} snapshot exceeds configured limit ${maximum}`);
    return client.sMembers(indexKey);
  }, deadline);
  if (members.length > maximum || members.some(value => !value || value.includes(':'))) {
    throw new Error(`Invalid ${name} snapshot`);
  }
  return [...new Set(members)].sort();
}

async function runCommand(redis: RedisStore, operation: Operation, actorId: string, osUser: string, requestId: string, targetId?: string, setting?: string) {
  const userKey = redis.keys.user;
  const sessionsKey = redis.keys.userSessions;
  const sessionKey = redis.keys.session;
  const adminsKey = redis.keys.platformAdmins();
  const auditKey = redis.keys.audit();

  const deadline = redis.deadline();
  return redis.withKeySnapshot(async (deadline) => {
    const target = targetId!;
    const adminIds = operation === 'revoke' || operation === 'suspend'
      ? await boundedSnapshot(redis, adminsKey, MAX_ADMINS, 'Platform Admin', deadline)
      : [];
    const sessionDigests = ['grant', 'revoke', 'suspend', 'revoke-sessions'].includes(operation)
      ? await boundedSnapshot(redis, sessionsKey(target), MAX_SESSIONS, 'session', deadline)
      : [];
    let functionName: string;
    let keys: string[];
    let args: string[];
    switch (operation) {
      case 'grant':
        functionName = 'sh_grant_admin';
        keys = [adminsKey, userKey(actorId), userKey(target), auditKey, sessionsKey(target), ...sessionDigests.map(sessionKey)];
        args = [actorId, target, osUser, requestId, JSON.stringify(sessionDigests)];
        break;
      case 'revoke':
      case 'suspend':
        functionName = operation === 'revoke' ? 'sh_revoke_admin' : 'sh_suspend_user';
        keys = [adminsKey, userKey(actorId), userKey(target), auditKey, sessionsKey(target), ...adminIds.map(userKey), ...sessionDigests.map(sessionKey)];
        args = [actorId, target, osUser, requestId, JSON.stringify(adminIds), JSON.stringify(sessionDigests)];
        break;
      case 'reactivate':
        functionName = 'sh_reactivate_user';
        keys = [adminsKey, userKey(actorId), userKey(target), auditKey, sessionsKey(target)];
        args = [actorId, target, osUser, requestId];
        break;
      case 'revoke-sessions':
        functionName = 'sh_revoke_sessions';
        keys = [adminsKey, userKey(actorId), userKey(target), auditKey, sessionsKey(target), ...sessionDigests.map(sessionKey)];
        args = [actorId, target, osUser, requestId, JSON.stringify(sessionDigests)];
        break;
      case 'registration':
        functionName = 'sh_set_platform_setting';
        keys = [adminsKey, userKey(actorId), redis.keys.platformSettings(), auditKey];
        args = [actorId, 'registrationEnabled', setting === 'on' ? '1' : '0', osUser, requestId];
        break;
    }
    return redis.call(functionName, keys, args, deadline);
  }, deadline);
}

export async function runAdminCli(args = process.argv.slice(2), env = process.env) {
  const requestId = makeId('req');
  let redis: RedisStore | undefined;
  let operation: Operation | undefined;
  try {
    const parsed = parseAdminArgs(args);
    operation = parsed.operation;
    const identity = await operatorIdentity(parsed.local, env);
    const config = readConfig('maintenance', env);
    redis = new RedisStore(config, 'maintenance');
    await redis.connect();
    if (!await redis.ready()) throw new Error('Redis Function library version mismatch');
    const reply = await runCommand(redis, parsed.operation, identity.userId, identity.osUser, requestId, parsed.target, parsed.setting);
    if (!reply.ok) {
      process.stdout.write(`${JSON.stringify({ error: { code: reply.code, params: reply.params }, requestId })}\n`);
      process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'warn', event: 'admin_cli', requestId, operation, code: reply.code })}\n`);
      process.exitCode = 1;
      return;
    }
    const data = reply.data as { changed?: unknown };
    process.stdout.write(`${JSON.stringify({ status: data?.changed === false ? 'no-op' : 'applied', requestId })}\n`);
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'info', event: 'admin_cli', requestId, operation, status: data?.changed === false ? 'no-op' : 'applied' })}\n`);
  } catch (error) {
    const code = error instanceof RedisFailure || error instanceof CliError ? error.code : 'CLI_CONFIGURATION_INVALID';
    process.stdout.write(`${JSON.stringify({ error: { code, params: {} }, requestId })}\n`);
    process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), level: 'error', event: 'admin_cli', requestId, operation, code })}\n`);
    process.exitCode = 1;
  } finally {
    redis?.close();
  }
}

if (import.meta.main) await runAdminCli();
