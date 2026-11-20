import { ApiError } from '../platform/http/errors.js';
import type { FunctionReply } from '../redis/reply.js';
import { USER_ID } from './auth.types.js';
import type { PublicProfile } from './auth.types.js';

const STATUSES = {
  INVALID_CREDENTIALS: 401,
  SESSION_INVALID: 401,
  USER_SUSPENDED: 401,
  REGISTRATION_DISABLED: 403,
  SESSION_LIMIT_REACHED: 409,
  USER_VERSION_CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
} as const;
const POLICIES = ['login-ip', 'login-acct', 'register', 'write'];

export function publicProfile(value: unknown): PublicProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(500, 'INTERNAL_ERROR');
  const { id, email, displayName, avatarUrl, locale, version } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !USER_ID.test(id) || typeof email !== 'string' || typeof displayName !== 'string'
    || (avatarUrl !== null && typeof avatarUrl !== 'string') || (locale !== 'en' && locale !== 'vi')
    || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new ApiError(500, 'INTERNAL_ERROR');
  }
  return { id, email, displayName, avatarUrl, locale, version };
}

export function authResult(reply: FunctionReply) {
  if (reply.ok) {
    if (reply.seq !== null) throw new ApiError(500, 'INTERNAL_ERROR');
    return reply.data;
  }
  if (!Object.hasOwn(STATUSES, reply.code)) throw new ApiError(500, 'INTERNAL_ERROR');
  const code = reply.code as keyof typeof STATUSES;
  if (code === 'SESSION_LIMIT_REACHED') throw new ApiError(409, code, { limit: 32 });
  if (code === 'USER_VERSION_CONFLICT') {
    const currentVersion = reply.params.currentVersion;
    if (!Number.isSafeInteger(currentVersion)) throw new ApiError(500, 'INTERNAL_ERROR');
    throw new ApiError(409, code, { currentVersion });
  }
  throw new ApiError(STATUSES[code], code);
}

export function rateLimited(blocks: { policy: string; retryAfter: number }[]) {
  return new ApiError(429, 'RATE_LIMITED', {}, {
    'Retry-After': String(Math.max(...blocks.map(({ retryAfter }) => retryAfter))),
    RateLimit: blocks.map(({ policy, retryAfter }) => `"${policy}";r=0;t=${retryAfter}`).join(', '),
  });
}

export function checkRate(data: unknown) {
  const blocked = data && typeof data === 'object' && 'blocked' in data ? data.blocked : undefined;
  if (!Array.isArray(blocked)) throw new ApiError(500, 'INTERNAL_ERROR');
  const valid = blocked.map((block: unknown) => {
    if (!block || typeof block !== 'object' || !('policy' in block) || !('retryAfter' in block)
      || typeof block.policy !== 'string' || !POLICIES.includes(block.policy)
      || typeof block.retryAfter !== 'number' || !Number.isSafeInteger(block.retryAfter) || block.retryAfter < 1) {
      throw new ApiError(500, 'INTERNAL_ERROR');
    }
    return { policy: block.policy, retryAfter: block.retryAfter };
  });
  if (valid.length) throw rateLimited(valid);
}
