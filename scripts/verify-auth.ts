import { createHash } from 'node:crypto';
import { readConfig } from '../src/platform/config.js';
import { RedisStore } from '../src/redis/client.js';

type User = {
  id: string;
  emailNormalized: string;
  emailDigest?: string;
  createdAtMs: number;
  disabledAt?: string | null;
};
type Session = Record<string, string>;

function fail(message: string): never { throw new Error(message); }
function digestEmail(email: string) { return createHash('sha256').update(email).digest('hex'); }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function scanKeys(redis: RedisStore, match: string): Promise<string[]> {
  return redis.read(async client => {
    const found: string[] = [];
    let cursor = '0';
    do {
      const result = await client.sendCommand(['SCAN', cursor, 'MATCH', match, 'COUNT', '200']) as unknown;
      if (!Array.isArray(result) || result.length !== 2 || typeof result[0] !== 'string' || !Array.isArray(result[1])) {
        fail('Unexpected SCAN reply');
      }
      cursor = result[0];
      found.push(...(result[1] as unknown[]).filter((value): value is string => typeof value === 'string'));
    } while (cursor !== '0');
    return found;
  });
}

async function json(redis: RedisStore, key: string): Promise<unknown> {
  const raw = await redis.read(client => client.sendCommand(['JSON.GET', key]));
  if (raw === null) return null;
  if (typeof raw !== 'string') fail(`Invalid JSON.GET response for ${key}`);
  try { return JSON.parse(raw); } catch { fail(`Malformed JSON at ${key}`); }
}

async function hash(redis: RedisStore, key: string): Promise<Session> {
  const result = await redis.read(client => client.hGetAll(key));
  return result;
}

async function verifyAuth(redis: RedisStore): Promise<string[]> {
  const { prefix } = redis.keys;
  const errors: string[] = [];
  const users = new Map<string, User>();
  const userPattern = `${prefix}user:*`;
  const userKeys = (await scanKeys(redis, userPattern)).filter(key => !key.slice(prefix.length + 5).includes(':'));

  for (const key of userKeys) {
    const id = key.slice(`${prefix}user:`.length);
    let value: unknown;
    try { value = await json(redis, key); }
    catch { errors.push(`invalid user document type or JSON: ${id}`); continue; }
    if (!isRecord(value) || value.id !== id || typeof value.emailNormalized !== 'string' || !Number.isSafeInteger(value.createdAtMs)) {
      errors.push(`invalid user document: ${id}`);
      continue;
    }
    const user = value as unknown as User;
    users.set(id, user);
    const digest = digestEmail(user.emailNormalized);
    if (user.emailDigest !== undefined && user.emailDigest !== digest) errors.push(`email digest mismatch: ${id}`);
    try {
      const mappedId = await redis.read(client => client.get(`${prefix}user-email:${digest}`));
      if (mappedId !== id) errors.push(`email mapping mismatch: ${id}`);
    } catch { errors.push(`invalid email mapping type: ${id}`); }
    try {
      const score = await redis.read(client => client.zScore(`${prefix}users-by-created`, id));
      if (score === null || score !== user.createdAtMs) errors.push(`created index mismatch: ${id}`);
    } catch { errors.push(`invalid created index type: ${id}`); }
  }

  for (const key of await scanKeys(redis, `${prefix}user-email:*`)) {
    const digest = key.slice(`${prefix}user-email:`.length);
    try {
      const id = await redis.read(client => client.get(key));
      const user = id ? users.get(id) : undefined;
      if (!user) errors.push(`stale email mapping: ${digest}`);
      else if (digestEmail(user.emailNormalized) !== digest) errors.push(`email mapping points to a different address: ${digest}`);
    } catch { errors.push(`invalid email mapping type: ${digest}`); }
  }

  try {
    const createdMembers = await redis.read(client => client.zRange(`${prefix}users-by-created`, 0, -1));
    for (const id of createdMembers) if (!users.has(id)) errors.push(`stale created index member: ${id}`);
  } catch { errors.push('invalid users-by-created index type'); }

  const indexedSessions = new Map<string, Set<string>>();
  for (const [id, user] of users) {
    let members: string[];
    try { members = await redis.read(client => client.sMembers(`${prefix}user-sessions:${id}`)); }
    catch { errors.push(`invalid session index type: ${id}`); indexedSessions.set(id, new Set()); continue; }
    indexedSessions.set(id, new Set(members));
    for (const digest of members) {
      let record: Session;
      try { record = await hash(redis, `${prefix}session:${digest}`); }
      catch { errors.push(`invalid session hash type: ${digest}`); continue; }
      if (Object.keys(record).length === 0) continue; // stale SET members are cleaned by session mutations.
      if (record.userId !== id) errors.push(`session owner mismatch: ${digest}`);
      const expiresAtMs = Number(record.expiresAtMs);
      const absoluteExpiresAtMs = Number(record.absoluteExpiresAtMs);
      if (!Number.isFinite(expiresAtMs) || !Number.isFinite(absoluteExpiresAtMs)) {
        errors.push(`invalid session timestamps: ${digest}`);
      } else if (Math.min(expiresAtMs, absoluteExpiresAtMs) > Date.now() && user.disabledAt != null) {
        errors.push(`disabled user has an active session: ${id}`);
      }
    }
  }

  for (const key of await scanKeys(redis, `${prefix}session:*`)) {
    const digest = key.slice(`${prefix}session:`.length);
    let record: Session;
    try { record = await hash(redis, key); }
    catch { errors.push(`invalid session hash type: ${digest}`); continue; }
    if (Object.keys(record).length === 0) continue;
    const expiry = Math.min(Number(record.expiresAtMs), Number(record.absoluteExpiresAtMs));
    if (expiry <= Date.now()) continue;
    const user = users.get(record.userId);
    if (!user) errors.push(`active session has no user: ${digest}`);
    else if (!indexedSessions.get(record.userId)?.has(digest)) errors.push(`active session is missing from user index: ${digest}`);
  }

  let adminIds: string[];
  try { adminIds = await redis.read(client => client.sMembers(`${prefix}platform-admins`)); }
  catch { errors.push('invalid Platform Admin set type'); return errors; }
  if (adminIds.length > 16) errors.push(`Platform Admin set exceeds limit: ${adminIds.length}`);
  let activeAdmins = 0;
  for (const id of adminIds) {
    const user = users.get(id);
    if (!user) errors.push(`Platform Admin has no user: ${id}`);
    else if (user.disabledAt == null) activeAdmins++;
  }
  if (adminIds.length > 0 && activeAdmins === 0) errors.push('no active Platform Admin remains');
  return errors;
}

async function main() {
  const redis = new RedisStore(readConfig('maintenance'), 'maintenance');
  try {
    await redis.client.connect();
    const errors = await verifyAuth(redis);
    if (errors.length) {
      for (const error of errors) process.stderr.write(`ERROR ${error}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write('Auth data verified.\n');
    }
  } finally {
    redis.close();
  }
}

if (import.meta.main) await main().catch(() => {
  process.stderr.write('Auth verification could not complete. Check Redis connectivity and data types.\n');
  process.exitCode = 1;
});

export { verifyAuth };
