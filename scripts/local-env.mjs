import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

const port = process.env.REDIS_PORT || '16390';
if (!/^\d+$/.test(port) || Number(port) > 65535 || Number(port) < 1) {
  throw new Error('REDIS_PORT must be a valid port');
}
const project = process.env.COMPOSE_PROJECT_NAME || ('sprinthub-' + basename(process.cwd()).toLowerCase()).replace(/[^a-z0-9_-]/g, '-');
const lines = [
  `COMPOSE_PROJECT_NAME=${project}`, `REDIS_PORT=${port}`,
  `AUTH_ORIGIN=${process.env.AUTH_ORIGIN || 'http://localhost:3000'}`,
  `AUTH_IP_HMAC_SECRET=${randomBytes(32).toString('hex')}`,
];
for (const [name, user] of [['APP', 'sh-app'], ['WORKER', 'sh-worker'], ['MAINT', 'sh-maint']]) {
  const password = randomBytes(32).toString('hex');
  lines.push(`REDIS_${name}_PASSWORD=${password}`, `REDIS_${name}_URL=redis://${user}:${password}@127.0.0.1:${port}`);
}
try {
  await writeFile('.env', lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
