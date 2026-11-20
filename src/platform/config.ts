export type ProcessRole = 'api' | 'worker' | 'maintenance';
export const LIB_VERSION = 2;

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
  return {
    role, redisUrl, prefix, host,
    port: role === 'api' ? positiveInteger(env, 'API_PORT', 3000, 65535) : 0,
    timeoutMs: positiveInteger(env, 'REDIS_TIMEOUT_MS', 200),
    shutdownMs: positiveInteger(env, 'SHUTDOWN_TIMEOUT_MS', 5000),
    libVersion: positiveInteger(env, 'REDIS_LIB_VERSION', LIB_VERSION),
  };
}

export type RuntimeConfig = ReturnType<typeof readConfig>;
