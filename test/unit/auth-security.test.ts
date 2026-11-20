import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { emailDigest, cookieToken, normalizeEmail, canonicalClientIp, ipDigest, assertCsrf } from '../../src/auth/auth.security.js';
import { PatchProfileDto } from '../../src/auth/auth.dto.js';

describe('auth HTTP security helpers', () => {
  it('normalizes email for lookup but preserves its display form', () => {
    expect(normalizeEmail(' User@Example.COM ')).toEqual({ display: 'User@Example.COM', normalized: 'user@example.com' });
    expect(emailDigest('user@example.com')).toBe(emailDigest('user@example.com'));
    expect(emailDigest('user@example.com')).not.toBe(emailDigest('other@example.com'));
  });

  it('accepts only canonical 32-byte base64url session cookies', () => {
    const token = Buffer.alloc(32, 7).toString('base64url');
    expect(cookieToken({ headers: { cookie: `a=b; __Host-sh_session=${token}` } } as never)).toBe(token);
    expect(cookieToken({ headers: { cookie: '__Host-sh_session=invalid' } } as never)).toBeUndefined();
    expect(cookieToken({ headers: { cookie: `__Host-sh_session=${token}=` } } as never)).toBeUndefined();
  });

  it('uses forwarded IP only when the peer is a configured trusted proxy', () => {
    const request = (peer: string, ip: string) => ({
      socket: { remoteAddress: peer }, ip, headers: {},
    } as never);
    expect(canonicalClientIp(request('10.0.0.4', '198.51.100.5'), ['10.0.0.0/8'])).toBe('198.51.100.5');
    expect(canonicalClientIp(request('10.0.0.4', '198.51.100.5'), [])).toBe('10.0.0.4');
    expect(ipDigest('198.51.100.5', 'secret')).not.toBe(ipDigest('198.51.100.5', 'another-secret'));
  });

  it('rejects mutations without the configured same-origin CSRF headers', () => {
    expect(() => assertCsrf({ headers: { origin: 'https://app.example', 'x-csrf-protection': '1' } } as never,
      'https://app.example')).not.toThrow();
    expect(() => assertCsrf({ headers: { origin: 'https://evil.example', 'x-csrf-protection': '1' } } as never,
      'https://app.example')).toThrow('CSRF_INVALID');
    expect(() => assertCsrf({ headers: { origin: 'https://app.example' } } as never,
      'https://app.example')).toThrow('CSRF_INVALID');
  });

  it('validates profile patch allow-list values and trimmed code point length', async () => {
    const valid = plainToInstance(PatchProfileDto, { expectedVersion: 2, displayName: '  Ada  ', avatarUrl: null, locale: 'vi' });
    expect(await validate(valid, { whitelist: true, forbidNonWhitelisted: true })).toHaveLength(0);
    const invalid = plainToInstance(PatchProfileDto, {
      expectedVersion: 2, locale: null, avatarUrl: 'http://example.test/avatar', disabledAt: null,
    });
    const errors = await validate(invalid, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((error) => error.property).sort()).toEqual(['avatarUrl', 'disabledAt', 'locale']);
  });
});
