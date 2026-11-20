import { readConfig } from '../platform/config.js';
import { log, startupFailed } from '../platform/log.js';
import { createApi } from './app.js';

async function main() {
  const config = readConfig('api');
  const app = await createApi(config);
  try {
    await app.listen(config.port, config.host);
  } catch (error) {
    await app.close();
    throw error;
  }

  const shutdown = async () => {
    const timeout = setTimeout(() => process.exit(1), config.shutdownMs).unref();
    await app.close();
    clearTimeout(timeout);
    log('info', 'api_shutdown');
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  log('info', 'api_listening', { port: config.port });
}

await main().catch((error: unknown) => startupFailed('api', error));
