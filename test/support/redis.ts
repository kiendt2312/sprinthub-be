import { once } from 'node:events';
import { createServer, connect } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { readConfig } from '../../src/platform/config.js';
import type { ProcessRole } from '../../src/platform/config.js';
import { RedisStore } from '../../src/redis/client.js';

export function integrationStore(role: ProcessRole = 'maintenance') {
  return new RedisStore(readConfig(role), role === 'maintenance' ? 'maintenance' : 'request');
}

export async function connected(store = integrationStore()) {
  try {
    await store.client.connect();
    return store;
  } catch (error) {
    store.close();
    throw error;
  }
}

// Forward real Redis traffic while letting tests discard one specific command's reply.
export async function redisProxy(redisUrl: string) {
  const destination = new URL(redisUrl);
  const sockets = new Set<Socket>();
  let match: string | undefined;
  let replacement: string | undefined;
  let count = 0;
  const server = createServer((client) => {
    const upstream = connect({ host: destination.hostname, port: Number(destination.port || '6379') });
    sockets.add(client);
    sockets.add(upstream);
    let replace = false;
    client.on('data', (data) => {
      if (match && data.includes(Buffer.from(match))) {
        count++;
        replace = true;
        if (replacement !== undefined) {
          replace = false;
          client.write(replacement);
          return;
        }
      }
      upstream.write(data);
    });
    upstream.on('data', (data) => {
      if (!replace) client.write(data);
    });
    client.on('error', () => client.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => { sockets.delete(client); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = new URL(destination);
  address.hostname = '127.0.0.1';
  address.port = String((server.address() as AddressInfo).port);
  return {
    url: address.toString(),
    trap(command: string, reply?: string) { match = command; replacement = reply; },
    get count() { return count; },
    disconnect() { for (const socket of sockets) socket.destroy(); },
    async close() {
      this.disconnect();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
