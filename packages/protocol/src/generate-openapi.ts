import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOpenApiDocument } from './openapi.js';

const outputUrl = new URL('../../../api/openapi.json', import.meta.url);
const outputPath = fileURLToPath(outputUrl);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`,
  'utf8',
);
