import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import type { Request, Response } from 'express';
import { ApiError } from '../platform/http/errors.js';
import type { RuntimeConfig } from '../platform/config.js';
import { RUNTIME_CONFIG } from '../redis/redis.module.js';
import { makeId } from '../platform/http/request.js';
import { log } from '../platform/log.js';
import { AuthRepository } from './auth.repository.js';
import { authResult, checkRate, publicProfile } from './auth.responses.js';
import { USER_ID } from './auth.types.js';
import { canonicalClientIp, clearCookie, cookieToken, emailDigest, ipDigest, setSessionCookie, validateEmail } from './auth.security.js';
import type { LoginDto, RegisterDto } from './auth.dto.js';

const ARGON_OPTIONS = {
  algorithm: 2, // Argon2id in the native binding.
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 4,
  outputLen: 32,
};
let dummyHash: Promise<string> | undefined;

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private readonly repository: AuthRepository,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
  ) {}

  get sessionTouchMs() { return this.config.sessionTouchMs; }

  async onModuleInit() {
    await this.#getDummyHash();
  }

  async register(dto: RegisterDto, request: Request) {
    const { display, normalized } = validateEmail(dto.email);
    const displayName = dto.displayName.trim();
    checkRate(authResult(await this.repository.takeRate('register', this.#clientIpHash(request))));
    const passwordHash = await hash(dto.password, ARGON_OPTIONS);
    authResult(await this.repository.register({
      id: makeId('usr'), emailDigest: emailDigest(normalized), normalizedEmail: normalized, displayEmail: display,
      passwordHash, displayName,
    }));
    return { status: 'accepted' as const };
  }

  async login(dto: LoginDto, request: Request, response: Response) {
    const { normalized } = validateEmail(dto.email);
    const emailSha = emailDigest(normalized);
    checkRate(authResult(await this.repository.takeRate('login', this.#clientIpHash(request), emailSha)));
    const uid = await this.repository.findUserId(emailSha);
    const user = uid && USER_ID.test(uid) ? await this.repository.getUser(uid) : null;
    const storedHash = user?.passwordHash;
    const digestToVerify = typeof storedHash === 'string' ? storedHash : await this.#getDummyHash();
    const validPassword = await verify(digestToVerify, dto.password, ARGON_OPTIONS).catch(() => false);
    if (!uid || !user || typeof storedHash !== 'string' || !validPassword) {
      throw new ApiError(401, 'INVALID_CREDENTIALS');
    }

    const token = randomBytes(32).toString('base64url');
    const previousToken = cookieToken(request);
    const priorDigest = previousToken ? sha256(previousToken) : '';
    // The Function rotates the prior digest only when it is in this user's verified snapshot.
    const data = publicProfile(authResult(await this.repository.createSession({
      uid, emailDigest: emailSha, digest: sha256(token), id: makeId('ses'), priorDigest,
    })));
    setSessionCookie(response, token);
    return data;
  }

  async logout(request: Request, response: Response, all = false) {
    const token = cookieToken(request);
    if (token) {
      const digest = sha256(token);
      const { userId } = await this.repository.getSession(digest);
      if (userId && USER_ID.test(userId)) {
        const reply = all ? await this.repository.revokeAllSessions(userId, digest)
          : await this.repository.revokeSession(userId, digest);
        authResult(reply);
      }
    }
    clearCookie(response);
  }

  logoutAll(request: Request, response: Response) {
    return this.logout(request, response, true);
  }

  async takeWriteLimit(userId: string) {
    checkRate(authResult(await this.repository.takeRate('write', userId)));
  }

  async onSessionTouch(userId: string, digest: string, requestId: string) {
    try {
      authResult(await this.repository.touchSession(userId, digest, this.sessionTouchMs));
    } catch {
      log('warn', 'session_touch_failed', { requestId });
    }
  }

  #clientIpHash(request: Request) {
    return ipDigest(canonicalClientIp(request, this.config.trustedProxies), this.config.ipHmacSecret);
  }

  #getDummyHash() {
    dummyHash ??= hash(randomBytes(32), ARGON_OPTIONS);
    return dummyHash;
  }
}
