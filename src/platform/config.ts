import { isIP } from 'node:net';

export type ProcessRole = 'api' | 'worker' | 'maintenance';
export const LIB_VERSION = 4;
export const DEFAULT_UNASSIGN_BATCH_SIZE = 50;
const MAX_UNASSIGN_BATCH_SIZE = 100;

export class ConfigError extends Error {
  constructor(readonly variable: string) {
    super('Invalid environment configuration');
  }
}

export function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, max = 2_147_483_647) {
  const raw = env[key] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new ConfigError(key);
  }
  return value;
}

function authConfig(env: NodeJS.ProcessEnv) {
  let authOrigin: string;
  try {
    const origin = new URL(env.AUTH_ORIGIN ?? '');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash) throw new Error();
    authOrigin = origin.origin;
  } catch {
    throw new ConfigError('AUTH_ORIGIN');
  }
  const ipHmacSecret = env.AUTH_IP_HMAC_SECRET ?? '';
  if (Buffer.byteLength(ipHmacSecret) < 32) throw new ConfigError('AUTH_IP_HMAC_SECRET');

  const trustedProxies = (env.AUTH_TRUSTED_PROXIES ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  for (const address of trustedProxies) {
    const [ip, bits, extra] = address.split('/');
    const family = isIP(ip);
    if (!family || extra !== undefined || (bits !== undefined && (!/^\d+$/.test(bits)
      || Number(bits) < 1 || Number(bits) > (family === 4 ? 32 : 128)))) {
      throw new ConfigError('AUTH_TRUSTED_PROXIES');
    }
  }
  return { authOrigin, ipHmacSecret, trustedProxies, sessionTouchMs: positiveInteger(env, 'AUTH_SESSION_TOUCH_MS', 600_000) };
}

export function readConfig(role: ProcessRole, env = process.env) {
  const variable = { api: 'REDIS_APP_URL', worker: 'REDIS_WORKER_URL', maintenance: 'REDIS_MAINT_URL' }[role];
  const username = { api: 'sh-app', worker: 'sh-worker', maintenance: 'sh-maint' }[role];
  const redisUrl = env[variable];
  try {
    if (!redisUrl) throw new Error();
    const url = new URL(redisUrl);
    if (!['redis:', 'rediss:'].includes(url.protocol) || !url.hostname
      || url.username !== username || !url.password
      || (url.pathname && url.pathname !== '/' && url.pathname !== '/0')
      || url.search || url.hash) throw new Error();
    decodeURIComponent(url.password);
  } catch {
    throw new ConfigError(variable);
  }
  const prefix = env.REDIS_KEY_PREFIX ?? 'sh:v1:';
  if (!/^[A-Za-z0-9:_-]+:$/.test(prefix) || prefix.length > 80) {
    throw new ConfigError('REDIS_KEY_PREFIX');
  }
  const host = role === 'api' ? env.API_HOST ?? '127.0.0.1' : '';
  if (role === 'api' && !/^[0-9A-Za-z.:-]+$/.test(host)) throw new ConfigError('API_HOST');
  const libVersion = positiveInteger(env, 'REDIS_LIB_VERSION', LIB_VERSION);
  if (libVersion !== LIB_VERSION) throw new ConfigError('REDIS_LIB_VERSION');
  const auth = role === 'api' ? authConfig(env) : {
    authOrigin: '', ipHmacSecret: '', trustedProxies: [], sessionTouchMs: 600_000,
  };
  return {
    ...auth, role, redisUrl, prefix, host,
    port: role === 'api' ? positiveInteger(env, 'API_PORT', 3000, 65535) : 0,
    timeoutMs: positiveInteger(env, 'REDIS_TIMEOUT_MS', 200),
    shutdownMs: positiveInteger(env, 'SHUTDOWN_TIMEOUT_MS', 5000),
    unassignBatchSize: role === 'worker'
      ? positiveInteger(env, 'UNASSIGN_BATCH_SIZE', DEFAULT_UNASSIGN_BATCH_SIZE, MAX_UNASSIGN_BATCH_SIZE)
      : DEFAULT_UNASSIGN_BATCH_SIZE,
    libVersion,
  };
}

export type RuntimeConfig = ReturnType<typeof readConfig>;
