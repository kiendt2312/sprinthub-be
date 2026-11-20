export const USER_ID = /^usr_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
export const SESSION_ID = /^ses_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function timestamp(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

export interface PublicProfile {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  locale: 'en' | 'vi';
  version: number;
}

export interface CurrentSession {
  userId: string;
  digest: string;
  lastSeenAtMs: number;
}

export interface AuthRateLimit {
  policy: 'login-ip' | 'login-acct' | 'register' | 'write' | 'board';
  subject: string;
  windowSeconds: number;
  limit: number;
}

export interface AuthenticatedRequest {
  auth?: CurrentSession;
  /** Set only by trusted server middleware, never derived from an HTTP header or body. */
  authRateLimit?: AuthRateLimit;
  requestId: string;
}
