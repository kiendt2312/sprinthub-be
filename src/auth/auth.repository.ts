import { Injectable } from '@nestjs/common';
import { RedisFailure, RedisStore } from '../redis/client.js';
import type { AuthRateLimit, CurrentSession } from './auth.types.js';

const SESSION_LIMIT = 32;

export type SessionHash = Record<string, string | undefined>;
function sessionHash(value: unknown): SessionHash {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.values(value).every((field) => typeof field === 'string')) {
    throw new RedisFailure('INTERNAL_ERROR');
  }
  return value as SessionHash;
}

type ProfilePatch = { displayName?: string; avatarUrl?: string | null; locale?: 'en' | 'vi' };

@Injectable()
export class AuthRepository {
  constructor(private readonly redis: RedisStore) {}

  findUserId(emailDigest: string) {
    return this.redis.read((client) => client.get(this.redis.keys.userEmail(emailDigest)));
  }

  async getUser(userId: string): Promise<Record<string, unknown> | null> {
    const value = await this.redis.read((client) => client.json.get(this.redis.keys.user(userId)));
    if (value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) throw new RedisFailure('INTERNAL_ERROR');
    return value as Record<string, unknown>;
  }

  getSession(digest: string): Promise<SessionHash> {
    return this.redis.read((client) => client.hGetAll(this.redis.keys.session(digest)));
  }

  async getSessionWithQuota(digest: string, quota: AuthRateLimit) {
    const { keys } = this.redis;
    const key = keys.rateLimit(quota.policy, quota.subject);
    const [session, count, , ttl] = await this.redis.mutate((client) => client.multi()
      .hGetAll(keys.session(digest))
      .incr(key)
      .expire(key, quota.windowSeconds, 'NX')
      .pTTL(key)
      .execAsPipeline());
    if (typeof count !== 'number' || typeof ttl !== 'number') throw new RedisFailure('INTERNAL_ERROR');
    return { session: sessionHash(session), count, ttl };
  }

  async listSessions(userId: string) {
    const deadline = this.redis.deadline();
    const { keys } = this.redis;
    const digests = await this.#sessionSnapshot(keys.userSessions(userId), deadline);
    if (digests.length === 0) return [];
    const records = await this.redis.read((client) => {
      const pipeline = client.multi();
      for (const digest of digests) pipeline.hGetAll(keys.session(digest));
      return pipeline.execAsPipeline();
    }, deadline);
    return digests.map((digest, index) => ({ digest, record: sessionHash(records[index]) }));
  }

  register(user: {
    id: string; emailDigest: string; normalizedEmail: string; displayEmail: string;
    passwordHash: string; displayName: string;
  }) {
    const { keys } = this.redis;
    return this.redis.call('sh_register_user',
      [keys.platformSettings(), keys.userEmail(user.emailDigest), keys.user(user.id), keys.usersByCreated()],
      [user.id, user.emailDigest, user.normalizedEmail, user.displayEmail, user.passwordHash, user.displayName]);
  }

  createSession(session: {
    uid: string; emailDigest: string; digest: string; id: string; priorDigest: string;
  }) {
    const { keys } = this.redis;
    const index = keys.userSessions(session.uid);
    return this.redis.withKeySnapshot(async (deadline) => {
      const snapshot = await this.#sessionSnapshot(index, deadline);
      return this.redis.call('sh_create_session', [
        keys.userEmail(session.emailDigest), keys.user(session.uid), index, keys.session(session.digest),
        ...snapshot.map(keys.session),
      ], [session.uid, session.emailDigest, session.digest, session.id, session.priorDigest, JSON.stringify(snapshot)], deadline);
    });
  }

  revokeSession(uid: string, digest: string) {
    const { keys } = this.redis;
    return this.redis.call('sh_logout_session',
      [keys.session(digest), keys.user(uid), keys.userSessions(uid)], [uid, digest]);
  }

  revokeAllSessions(uid: string, digest: string) {
    const { keys } = this.redis;
    const index = keys.userSessions(uid);
    return this.redis.withKeySnapshot(async (deadline) => {
      const snapshot = await this.#sessionSnapshot(index, deadline);
      return this.redis.call('sh_logout_all_sessions',
        [keys.session(digest), keys.user(uid), index, ...snapshot.map(keys.session)],
        [uid, digest, JSON.stringify(snapshot)], deadline);
    });
  }

  touchSession(uid: string, digest: string, intervalMs: number) {
    const { keys } = this.redis;
    return this.redis.call('sh_touch_session',
      [keys.session(digest), keys.userSessions(uid)], [uid, digest, String(intervalMs)]);
  }

  takeRate(scope: 'login' | 'register' | 'write', subject: string, accountDigest = '') {
    const { keys } = this.redis;
    const limits = scope === 'login'
      ? [keys.rateLimit('login-ip', subject), keys.rateLimit('login-acct', accountDigest)]
      : [keys.rateLimit(scope, subject)];
    return this.redis.call('sh_take_auth_rate_limit', limits, [scope, subject, accountDigest]);
  }

  updateProfile(session: CurrentSession, expectedVersion: number, patch: ProfilePatch, key: string, requestHash: string) {
    const { keys } = this.redis;
    return this.redis.call('sh_update_my_profile',
      [keys.session(session.digest), keys.user(session.userId), keys.userSessions(session.userId), keys.idempotency(session.userId, key)],
      [session.userId, session.digest, String(expectedVersion), JSON.stringify(patch), key, requestHash]);
  }

  async #sessionSnapshot(index: string, deadline: number) {
    const size = await this.redis.read((client) => client.sCard(index), deadline);
    if (size > SESSION_LIMIT) throw new RedisFailure('INTERNAL_ERROR');
    const digests = await this.redis.read((client) => client.sMembers(index), deadline);
    if (digests.length > SESSION_LIMIT) throw new RedisFailure('INTERNAL_ERROR');
    return digests.sort();
  }
}
