import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createOpenApiDocument } from '../src/index.js';

describe('OpenAPI contract', () => {
  it('is OpenAPI 3.1 and references schemas generated from Zod', () => {
    const document = createOpenApiDocument();

    expect(document.openapi).toBe('3.1.0');
    expect(document.components.securitySchemes.BatonOAuth).toMatchObject({
      type: 'oauth2',
      flows: {
        authorizationCode: {
          scopes: {
            'ingest:write': expect.any(String),
          },
        },
      },
    });
    expect(document.paths['/v1/ingestion/batches'].post.security).toEqual([
      { BatonOAuth: ['ingest:write'] },
    ]);
    expect(
      document.paths['/v1/ingestion/batches'].post.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/IngestionBatch' });
    expect(document.components.schemas.IngestionBatch).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(
      Object.keys(document.paths['/v1/ingestion/batches'].post.responses),
    ).toEqual(
      expect.arrayContaining([
        '202',
        '400',
        '401',
        '403',
        '409',
        '413',
        '415',
        '429',
      ]),
    );
    expect(
      document.paths['/v1/ingestion/batches'].post.responses['401'].content[
        'application/problem+json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/ApiProblem' });

    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        '/oauth/device/authorize',
        '/oauth/token',
        '/v1/devices',
        '/v1/projects',
        '/v1/projects/{projectId}/consents',
        '/v1/projects/{projectId}/consents/{consentRecordId}',
        '/v1/ingestion/checkpoint',
        '/v1/work-threads',
        '/v1/work-threads/{workThreadId}/events',
      ]),
    );
    expect(
      document.paths['/v1/work-threads/{workThreadId}/events'].get.security,
    ).toEqual([{ BatonOAuth: ['work:read'] }]);
    expect(document.components.schemas).toMatchObject({
      DeviceAuthorizationRequest: { type: 'object' },
      Project: { type: 'object' },
      WorkThread: { type: 'object' },
      EventReadback: { type: 'object' },
      ApiProblem: { type: 'object', additionalProperties: false },
      ConsentList: { type: 'object', additionalProperties: false },
      IngestionCheckpoint: { type: 'object', additionalProperties: false },
    });
  });

  it('keeps the committed artifact synchronized with the Zod source', async () => {
    const artifactUrl = new URL('../../../api/openapi.json', import.meta.url);
    const artifact = await readFile(artifactUrl, 'utf8');

    expect(JSON.parse(artifact) as unknown).toEqual(createOpenApiDocument());
  });
});
