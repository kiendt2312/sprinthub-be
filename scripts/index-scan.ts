import type { RedisStore } from '../src/redis/client.js';

export async function scanByPrefix(client: RedisStore['client'], prefix: string) {
  const pattern = `${prefix.replace(/[\\*?[\]]/g, '\\$&')}*`;
  const found = new Set<string>();
  for await (const batch of client.scanIterator({ MATCH: pattern, COUNT: 500 })) {
    for (const key of batch) found.add(key);
  }
  return [...found].sort();
}
