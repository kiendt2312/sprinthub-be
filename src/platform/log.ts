import type { LoggerService } from '@nestjs/common';
import { ConfigError } from './config.js';

type Fields = Record<string, string | number | boolean>;

export function log(level: 'info' | 'warn' | 'error', event: string, fields: Fields = {}) {
  // Log only explicitly selected fields. Never serialize requests, errors or Redis commands.
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...fields });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}

export const nestLogger: LoggerService = {
  log: () => {},
  warn: () => log('warn', 'nest_warning'),
  error: () => log('error', 'nest_error'),
};

export function startupFailed(role: string, error: unknown) {
  log('error', 'startup_failed', error instanceof ConfigError ? { role, variable: error.variable } : { role });
  process.exitCode = 1;
}
