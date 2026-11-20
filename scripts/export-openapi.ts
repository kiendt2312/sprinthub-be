import { writeFile } from 'node:fs/promises';
import type { OperationObject } from '@nestjs/swagger';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createApi } from '../src/api/app.js';
import { readConfig } from '../src/platform/config.js';

const config = readConfig('api', { REDIS_APP_URL: 'redis://sh-app:unused@localhost' });
const app = await createApi(config);
try {
  const document = SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle('SprintHub API')
    .setVersion('1.0')
    .build());
  for (const path of Object.values(document.paths)) {
    for (const method of ['get', 'post', 'patch', 'delete', 'put', 'head', 'options', 'trace'] as const) {
      const operation: OperationObject | undefined = path?.[method];
      for (const response of Object.values(operation?.responses ?? {})) {
        if (response && !('$ref' in response)) {
          response.headers = {
            ...response.headers,
            'X-Request-Id': { schema: { type: 'string', pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$' } },
            'Cache-Control': { schema: { type: 'string', enum: ['no-store'] } },
            'Server-Timing': { schema: { type: 'string' }, description: 'Application response time in milliseconds.' },
          };
        }
      }
    }
  }
  await writeFile('openapi.json', JSON.stringify(document, null, 2) + '\n');
} finally {
  await app.close();
}
