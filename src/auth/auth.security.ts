import { createHash, createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import { ApiError } from '../platform/http/errors.js';

export const SESSION_COOKIE = '__Host-sh_session';
export const SESSION_ABSOLUTE_SECONDS = 30 * 24 * 60 * 60;

export function normalizeEmail(value: string) {
  const display = value.trim();
  return { display, normalized: display.toLowerCase() };
}

export function emailDigest(normalized: string) {
  return createHash('sha256').update(normalized).digest('hex');
}

export function canonicalClientIp(request: Request, trustedProxies: string[]) {
  // Express computes req.ip using its configured trust proxy policy. Never parse
  // X-Forwarded-For here: untrusted clients can supply that header themselves.
  const peer = request.socket.remoteAddress ?? 'unknown';
  if (!trustedProxies.length) return peer.startsWith('::ffff:') ? peer.slice(7) : peer;
  const address = (trustedProxies.length ? request.ip : peer) || peer;
  if (address.startsWith('::ffff:')) return address.slice(7);
  if (isIP(address) === 6) {
    const hostname = new URL(`http://[${address}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  }
  return address;
}

export function ipDigest(ip: string, secret: string) {
  return createHmac('sha256', secret).update(ip).digest('hex');
}

export function cookieToken(request: Request): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0 || item.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = item.slice(separator + 1).trim();
    if (/^[A-Za-z0-9_-]{43}$/.test(value)) {
      const decoded = Buffer.from(value, 'base64url');
      if (decoded.length === 32 && decoded.toString('base64url') === value) return value;
    }
    return undefined;
  }
  return undefined;
}

export function assertCsrf(request: Request, authOrigin: string) {
  const origin = request.headers.origin;
  if (request.headers['x-csrf-protection'] !== '1' || typeof origin !== 'string' || origin !== authOrigin) {
    throw new ApiError(403, 'CSRF_INVALID');
  }
}

export function clearCookie(response: { setHeader(name: string, value: string): unknown }) {
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

export function setSessionCookie(response: { setHeader(name: string, value: string): unknown }, token: string) {
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_ABSOLUTE_SECONDS}; HttpOnly; Secure; SameSite=Lax`);
}
