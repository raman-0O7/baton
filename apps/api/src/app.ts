import cookie from '@fastify/cookie';
import {
  AuthError,
  createPkceMaterial,
  decodeWebLoginState,
  encodeWebLoginState,
  type AuthPrincipal,
  type IdentityService,
  type WebIdentityProvider,
} from '@baton/auth';
import { compileBootstrap, compileRetrievedContext } from '@baton/context';
import {
  IngestionStoreError,
  type IngestionRequestContext,
  type IngestionStore,
  type RetrievalStore,
  type WorkThreadStore,
} from '@baton/database';
import {
  beginHttpRequest,
  loggerRedactionPaths,
  ServiceMetrics,
  type HttpRequestObservation,
} from '@baton/observability';
import {
  AccountSchema,
  ConsentListSchema,
  ConsentRecordSchema,
  CreateConsentRequestSchema,
  CreateProjectRequestSchema,
  DeviceApprovalRequestSchema,
  DeviceApprovalResponseSchema,
  DeviceAuthorizationRequestSchema,
  DeviceAuthorizationResponseSchema,
  DeviceListSchema,
  IngestionAcknowledgementSchema,
  IngestionBatchSchema,
  IngestionCheckpointQuerySchema,
  IngestionCheckpointSchema,
  maxIngestionCompressedBytes,
  maxIngestionDecompressedBytes,
  ProjectListSchema,
  ProjectSchema,
  TokenRequestSchema,
  TokenResponseSchema,
  UpdateProjectRequestSchema,
  AssignWorkThreadSessionRequestSchema,
  CreateWorkThreadRequestSchema,
  EventReadbackSchema,
  ProjectReindexResultSchema,
  RetrievalResultSchema,
  RetrievalSearchQuerySchema,
  SourceSessionListSchema,
  ThreadContextQuerySchema,
  ThreadContextSchema,
  ThreadSuggestionListSchema,
  ThreadSuggestionQuerySchema,
  UpdateWorkThreadRequestSchema,
  WorkThreadEventsQuerySchema,
  WorkThreadListSchema,
  WorkThreadOverviewSchema,
  WorkThreadSchema,
  WorkThreadSessionListSchema,
  WorkThreadSessionSchema,
  type ApiErrorCode,
  type ApiProblem,
  type OAuthScope,
} from '@baton/protocol';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { gunzipSync } from 'node:zlib';

export interface ApiApplicationOptions {
  identity: IdentityService;
  identityProvider: WebIdentityProvider | null;
  ingestionStore?: IngestionStore;
  workThreadStore?: WorkThreadStore;
  retrievalStore?: RetrievalStore;
  publicApiUrl: string;
  dashboardUrl: string;
  cookieSecret: string;
  secureCookies?: boolean;
  logger?: boolean;
}

export async function buildApi(
  options: ApiApplicationOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: 'info',
            redact: { paths: loggerRedactionPaths, censor: '[REDACTED]' },
          },
    bodyLimit: 64 * 1024,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
  });
  await app.register(cookie);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      if (request.url.startsWith('/v1/ingestion/batches')) {
        done(null, body);
        return;
      }
      try {
        done(null, JSON.parse(body.toString('utf8')) as unknown);
      } catch {
        done(invalidRequest('The request body is not valid JSON.'));
      }
    },
  );

  const secure =
    options.secureCookies ??
    new URL(options.publicApiUrl).protocol === 'https:';
  const sessionCookie = secure ? '__Host-baton_session' : 'baton_session';
  const stateCookie = secure ? '__Host-baton_login_state' : 'baton_login_state';
  const metrics = new ServiceMetrics();

  app.addHook('onRequest', async (request) => {
    request.batonStartedAt = performance.now();
    request.batonObservation = beginHttpRequest(
      request.method,
      request.routeOptions.url ?? 'unmatched',
    );
  });
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin === new URL(options.dashboardUrl).origin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('vary', 'Origin');
      if (request.method === 'OPTIONS') {
        reply.header(
          'access-control-allow-methods',
          'GET, POST, PATCH, DELETE, OPTIONS',
        );
        reply.header(
          'access-control-allow-headers',
          'content-type, x-request-id',
        );
        return reply.status(204).send();
      }
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    const duration = performance.now() - request.batonStartedAt;
    metrics.observe(reply.statusCode, duration);
    request.batonObservation.finish(reply.statusCode, duration);
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => ({ status: 'ready' }));
  app.get('/metrics', async (_request, reply) => {
    return reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(metrics.prometheus());
  });

  app.get('/v1/auth/web/login', async (request, reply) => {
    if (options.identityProvider === null) {
      throw new HttpError(
        'internal_error',
        503,
        'Hosted web identity is not configured.',
      );
    }
    const query = parseObject(request.query);
    const returnTo = normalizeReturnTo(query.returnTo, options.dashboardUrl);
    const material = createPkceMaterial();
    const encoded = encodeWebLoginState(
      {
        state: material.state,
        codeVerifier: material.verifier,
        returnTo,
        expiresAt: Date.now() + 10 * 60 * 1000,
      },
      options.cookieSecret,
    );
    reply.setCookie(stateCookie, encoded, cookieOptions(secure, 10 * 60));
    const redirectUri = `${options.publicApiUrl}/v1/auth/web/callback`;
    return reply.redirect(
      options.identityProvider
        .authorizationUrl({
          state: material.state,
          codeVerifier: material.verifier,
          redirectUri,
        })
        .toString(),
    );
  });

  app.get('/v1/auth/web/callback', async (request, reply) => {
    if (options.identityProvider === null) {
      throw new HttpError(
        'internal_error',
        503,
        'Hosted web identity is not configured.',
      );
    }
    const query = parseObject(request.query);
    if (typeof query.code !== 'string' || typeof query.state !== 'string') {
      throw invalidRequest(
        'The authorization callback is missing code or state.',
      );
    }
    const state = decodeWebLoginState(
      request.cookies[stateCookie] ?? '',
      options.cookieSecret,
    );
    if (state === null || state.state !== query.state) {
      throw invalidRequest('The web login state is invalid or expired.');
    }
    const identity = await options.identityProvider.exchange({
      code: query.code,
      codeVerifier: state.codeVerifier,
      redirectUri: `${options.publicApiUrl}/v1/auth/web/callback`,
    });
    const session = await options.identity.establishBrowserSession(identity, {
      requestId: request.id,
    });
    reply.clearCookie(stateCookie, cookieOptions(secure));
    reply.setCookie(
      sessionCookie,
      session.sessionToken,
      cookieOptions(secure, secondsUntil(session.expiresAt)),
    );
    return reply.redirect(state.returnTo);
  });

  app.post('/oauth/device/authorize', async (request, reply) => {
    const input = parseSchema(DeviceAuthorizationRequestSchema, request.body);
    const output = await options.identity.beginDeviceAuthorization(input);
    return reply.send(DeviceAuthorizationResponseSchema.parse(output));
  });

  app.post('/oauth/token', async (request, reply) => {
    const input = parseSchema(TokenRequestSchema, request.body);
    const output = await options.identity.exchangeToken(input, {
      requestId: request.id,
    });
    return reply.send(TokenResponseSchema.parse(output));
  });

  app.post('/v1/auth/device/approve', async (request, reply) => {
    const principal = await authenticate(
      request,
      options.identity,
      sessionCookie,
      [],
    );
    const input = parseSchema(DeviceApprovalRequestSchema, request.body);
    const output = await options.identity.approveDevice(
      input.userCode,
      principal,
      {
        requestId: request.id,
      },
    );
    return reply.send(DeviceApprovalResponseSchema.parse(output));
  });

  app.get('/v1/account', async (request, reply) => {
    const principal = await authenticate(
      request,
      options.identity,
      sessionCookie,
      ['account:read'],
    );
    return reply.send(
      AccountSchema.parse(await options.identity.accountFor(principal)),
    );
  });

  app.get('/v1/devices', async (request, reply) => {
    const principal = await authenticate(
      request,
      options.identity,
      sessionCookie,
      ['devices:read'],
    );
    return reply.send(
      DeviceListSchema.parse({
        devices: await options.identity.listDevices(principal),
      }),
    );
  });

  app.delete<{ Params: { deviceId: string } }>(
    '/v1/devices/:deviceId',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['devices:write'],
      );
      if (!uuidPattern.test(request.params.deviceId)) {
        throw invalidRequest('The device ID must be a UUID.');
      }
      await options.identity.revokeDevice(principal, request.params.deviceId, {
        requestId: request.id,
      });
      return reply.status(204).send();
    },
  );

  app.post('/v1/auth/logout', async (request, reply) => {
    const principal = await authenticate(
      request,
      options.identity,
      sessionCookie,
      [],
    );
    await options.identity.logout(principal, { requestId: request.id });
    if (principal.credentialKind === 'browser_session') {
      reply.clearCookie(sessionCookie, cookieOptions(secure));
    }
    return reply.status(204).send();
  });

  app.get('/v1/projects', async (request, reply) => {
    const principal = await authenticate(
      request,
      options.identity,
      sessionCookie,
      ['projects:read'],
    );
    const output = await requireIngestionStore(options).listProjects(
      requestContext(principal, request.id),
    );
    return reply.send(ProjectListSchema.parse(output));
  });

  app.post('/v1/projects', async (request, reply) => {
    const principal = await authenticate(
      request,
      options.identity,
      sessionCookie,
      ['projects:write'],
    );
    const input = parseSchema(CreateProjectRequestSchema, request.body);
    const output = await requireIngestionStore(options).createProject(
      requestContext(principal, request.id),
      input,
    );
    return reply.status(201).send(ProjectSchema.parse(output));
  });

  app.patch<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['projects:write'],
      );
      requireUuid(request.params.projectId, 'project');
      const input = parseSchema(UpdateProjectRequestSchema, request.body);
      const output = await requireIngestionStore(options).updateProject(
        requestContext(principal, request.id),
        request.params.projectId,
        input,
      );
      return reply.send(ProjectSchema.parse(output));
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/consents',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['projects:read'],
      );
      requireUuid(request.params.projectId, 'project');
      const output = await requireIngestionStore(options).listConsents(
        requestContext(principal, request.id),
        request.params.projectId,
      );
      return reply.send(ConsentListSchema.parse(output));
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/consents',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['projects:write'],
      );
      requireUuid(request.params.projectId, 'project');
      const input = parseSchema(CreateConsentRequestSchema, request.body);
      const output = await requireIngestionStore(options).recordConsent(
        requestContext(principal, request.id),
        request.params.projectId,
        input,
      );
      return reply.status(201).send(ConsentRecordSchema.parse(output));
    },
  );

  app.delete<{
    Params: { projectId: string; consentRecordId: string };
  }>(
    '/v1/projects/:projectId/consents/:consentRecordId',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['projects:write'],
      );
      requireUuid(request.params.projectId, 'project');
      requireUuid(request.params.consentRecordId, 'consent record');
      await requireIngestionStore(options).revokeConsent(
        requestContext(principal, request.id),
        request.params.projectId,
        request.params.consentRecordId,
      );
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/ingestion/batches',
    { bodyLimit: maxIngestionCompressedBytes },
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['ingest:write'],
      );
      const decoded = decodeIngestionBody(
        request.body,
        request.headers['content-encoding'],
      );
      const input = parseSchema(IngestionBatchSchema, decoded);
      const output = await requireIngestionStore(options).ingestBatch(
        requestContext(principal, request.id),
        input,
      );
      return reply
        .status(202)
        .send(IngestionAcknowledgementSchema.parse(output));
    },
  );

  app.get('/v1/ingestion/checkpoint', async (request, reply) => {
    const principal = await authenticate(
      request,
      options.identity,
      sessionCookie,
      ['ingest:write'],
    );
    const query = parseSchema(IngestionCheckpointQuerySchema, request.query);
    const output = await requireIngestionStore(options).getCheckpoint(
      requestContext(principal, request.id),
      query,
    );
    return output === null
      ? reply.status(204).send()
      : reply.send(IngestionCheckpointSchema.parse(output));
  });

  app.get<{ Querystring: { projectId?: string } }>(
    '/v1/work-threads',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['work:read'],
      );
      const projectId = request.query.projectId;
      if (projectId === undefined || !uuidPattern.test(projectId)) {
        throw invalidRequest('A valid projectId query parameter is required.');
      }
      const output = await requireWorkThreadStore(options).listWorkThreads(
        requestContext(principal, request.id),
        projectId,
      );
      return reply.send(WorkThreadListSchema.parse(output));
    },
  );

  app.post('/v1/work-threads', async (request, reply) => {
    const principal = await authenticate(
      request,
      options.identity,
      sessionCookie,
      ['projects:write'],
    );
    const input = parseSchema(CreateWorkThreadRequestSchema, request.body);
    const output = await requireWorkThreadStore(options).createWorkThread(
      requestContext(principal, request.id),
      input,
    );
    return reply.status(201).send(WorkThreadSchema.parse(output));
  });

  app.patch<{ Params: { workThreadId: string } }>(
    '/v1/work-threads/:workThreadId',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['projects:write'],
      );
      requireUuid(request.params.workThreadId, 'work thread');
      const input = parseSchema(UpdateWorkThreadRequestSchema, request.body);
      const output = await requireWorkThreadStore(options).updateWorkThread(
        requestContext(principal, request.id),
        request.params.workThreadId,
        input,
      );
      return reply.send(WorkThreadSchema.parse(output));
    },
  );

  app.get<{ Params: { workThreadId: string } }>(
    '/v1/work-threads/:workThreadId/overview',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['work:read'],
      );
      requireUuid(request.params.workThreadId, 'work thread');
      const output = await requireWorkThreadStore(
        options,
      ).getWorkThreadOverview(
        requestContext(principal, request.id),
        request.params.workThreadId,
      );
      return reply.send(WorkThreadOverviewSchema.parse(output));
    },
  );

  app.get<{ Params: { workThreadId: string } }>(
    '/v1/work-threads/:workThreadId/sessions',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['work:read'],
      );
      requireUuid(request.params.workThreadId, 'work thread');
      const output = await requireWorkThreadStore(options).listThreadSessions(
        requestContext(principal, request.id),
        request.params.workThreadId,
      );
      return reply.send(WorkThreadSessionListSchema.parse(output));
    },
  );

  app.post<{ Params: { workThreadId: string } }>(
    '/v1/work-threads/:workThreadId/sessions',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['projects:write'],
      );
      requireUuid(request.params.workThreadId, 'work thread');
      const input = parseSchema(
        AssignWorkThreadSessionRequestSchema,
        request.body,
      );
      const output = await requireWorkThreadStore(options).assignSession(
        requestContext(principal, request.id),
        request.params.workThreadId,
        input,
      );
      return reply.status(201).send(WorkThreadSessionSchema.parse(output));
    },
  );

  app.delete<{ Params: { workThreadId: string; sourceSessionId: string } }>(
    '/v1/work-threads/:workThreadId/sessions/:sourceSessionId',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['projects:write'],
      );
      requireUuid(request.params.workThreadId, 'work thread');
      requireUuid(request.params.sourceSessionId, 'source session');
      await requireWorkThreadStore(options).removeSession(
        requestContext(principal, request.id),
        request.params.workThreadId,
        request.params.sourceSessionId,
      );
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { workThreadId: string } }>(
    '/v1/work-threads/:workThreadId/events',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['work:read'],
      );
      requireUuid(request.params.workThreadId, 'work thread');
      const query = parseSchema(WorkThreadEventsQuerySchema, request.query);
      const output = await requireWorkThreadStore(options).readWorkThreadEvents(
        requestContext(principal, request.id),
        request.params.workThreadId,
        {
          cursor: query.cursor ?? null,
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        },
      );
      return reply.send(EventReadbackSchema.parse(output));
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/source-sessions',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['work:read'],
      );
      requireUuid(request.params.projectId, 'project');
      const output = await requireWorkThreadStore(
        options,
      ).listProjectSourceSessions(
        requestContext(principal, request.id),
        request.params.projectId,
      );
      return reply.send(SourceSessionListSchema.parse(output));
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/thread-suggestions',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['work:read'],
      );
      requireUuid(request.params.projectId, 'project');
      const query = parseSchema(ThreadSuggestionQuerySchema, request.query);
      const output = await requireWorkThreadStore(options).suggestThreads(
        requestContext(principal, request.id),
        request.params.projectId,
        query.sourceSessionId ?? null,
      );
      return reply.send(ThreadSuggestionListSchema.parse(output));
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/reindex',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['projects:write'],
      );
      requireUuid(request.params.projectId, 'project');
      const indexedChunks = await requireRetrievalStore(options).reindexProject(
        requestContext(principal, request.id),
        request.params.projectId,
      );
      return reply.send(
        ProjectReindexResultSchema.parse({
          projectId: request.params.projectId,
          indexedChunks,
        }),
      );
    },
  );

  app.get('/v1/retrieval/search', async (request, reply) => {
    const principal = await authenticate(
      request,
      options.identity,
      sessionCookie,
      ['work:read'],
    );
    const query = parseSchema(RetrievalSearchQuerySchema, request.query);
    const context = requestContext(principal, request.id);
    const retrieval = requireRetrievalStore(options);
    // Refresh the derived chunk index so results reflect the latest events.
    await retrieval.reindexProject(context, query.projectId);
    const sourceSessionIds =
      query.workThreadId === undefined
        ? undefined
        : (
            await requireWorkThreadStore(options).listThreadSessions(
              context,
              query.workThreadId,
            )
          ).sessions.map((session) => session.sourceSession.sourceSessionId);
    const result = await retrieval.search(context, {
      projectId: query.projectId,
      workThreadId: query.workThreadId ?? null,
      ...(sourceSessionIds === undefined ? {} : { sourceSessionIds }),
      query: query.query,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return reply.send(RetrievalResultSchema.parse(result));
  });

  app.get<{ Params: { workThreadId: string } }>(
    '/v1/work-threads/:workThreadId/context',
    async (request, reply) => {
      const principal = await authenticate(
        request,
        options.identity,
        sessionCookie,
        ['work:read'],
      );
      requireUuid(request.params.workThreadId, 'work thread');
      const query = parseSchema(ThreadContextQuerySchema, request.query);
      const context = requestContext(principal, request.id);
      const overview = await requireWorkThreadStore(
        options,
      ).getWorkThreadOverview(context, request.params.workThreadId);
      const retrieval = requireRetrievalStore(options);
      await retrieval.reindexProject(context, overview.workThread.projectId);
      const sourceSessionIds = overview.sessions.map(
        (session) => session.sourceSession.sourceSessionId,
      );
      const searchText =
        query.query ?? overview.workThread.goal ?? overview.workThread.title;
      const result = await retrieval.search(context, {
        projectId: overview.workThread.projectId,
        workThreadId: request.params.workThreadId,
        sourceSessionIds,
        query: searchText,
        limit: 50,
      });
      const bootstrap = compileBootstrap(overview, { tokenBudget: 1000 });
      const evidence = compileRetrievedContext(result.chunks, {
        tokenBudget: query.tokenBudget ?? 2000,
      });
      return reply.send(
        ThreadContextSchema.parse({
          workThreadId: request.params.workThreadId,
          query: query.query ?? null,
          bootstrap,
          evidence,
        }),
      );
    },
  );

  app.setNotFoundHandler((request, reply) => {
    return reply
      .type('application/problem+json')
      .status(404)
      .send(
        problem(
          'not_found',
          404,
          'Not found',
          'The requested endpoint does not exist.',
          request.id,
        ),
      );
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error, request.id);
    if (mapped.status >= 500)
      request.log.error({ err: error }, 'request failed');
    if (mapped.retryAfterSeconds !== undefined) {
      reply.header('retry-after', String(mapped.retryAfterSeconds));
    }
    return reply
      .type('application/problem+json')
      .status(mapped.status)
      .send(mapped);
  });

  return app;
}

declare module 'fastify' {
  interface FastifyRequest {
    batonStartedAt: number;
    batonObservation: HttpRequestObservation;
  }
}

async function authenticate(
  request: FastifyRequest,
  identity: IdentityService,
  sessionCookie: string,
  scopes: readonly OAuthScope[],
): Promise<AuthPrincipal> {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const [scheme, token, extra] = authorization.split(' ');
    if (
      scheme?.toLowerCase() !== 'bearer' ||
      token === undefined ||
      extra !== undefined
    ) {
      throw new AuthError(
        'unauthorized',
        401,
        'A valid bearer credential is required.',
      );
    }
    return identity.authenticateAccessToken(token, scopes);
  }
  const browserToken = request.cookies[sessionCookie];
  if (browserToken !== undefined)
    return identity.authenticateBrowserSession(browserToken);
  throw new AuthError('unauthorized', 401, 'Authentication is required.');
}

class HttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

function invalidRequest(message: string): HttpError {
  return new HttpError('invalid_request', 400, message);
}

function mapError(error: unknown, requestId: string): ApiProblem {
  if (
    error instanceof AuthError ||
    error instanceof HttpError ||
    error instanceof IngestionStoreError
  ) {
    return problem(
      error.code,
      error.status,
      titleFor(error.code),
      error.message,
      requestId,
      error instanceof IngestionStoreError
        ? undefined
        : error.retryAfterSeconds,
    );
  }
  if (isFastifyBodyLimitError(error)) {
    return problem(
      'payload_too_large',
      413,
      'Payload Too Large',
      'The compressed ingestion batch exceeds the allowed byte limit.',
      requestId,
    );
  }
  if (isFastifyMediaTypeError(error)) {
    return problem(
      'invalid_request',
      415,
      'Unsupported Media Type',
      'The request content type is not supported.',
      requestId,
    );
  }
  return problem(
    'internal_error',
    500,
    'Internal server error',
    'The request could not be completed.',
    requestId,
  );
}

function problem(
  code: ApiErrorCode,
  status: number,
  title: string,
  detail: string,
  requestId: string,
  retryAfterSeconds?: number,
): ApiProblem {
  return {
    type: `https://baton.dev/problems/${code.replaceAll('_', '-')}`,
    title,
    status,
    code,
    detail,
    requestId,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

function titleFor(code: ApiErrorCode): string {
  return code
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function parseSchema<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidRequest('The request body is invalid.');
  return parsed.data;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return {};
  return value as Record<string, unknown>;
}

function normalizeReturnTo(value: unknown, dashboardUrl: string): string {
  const base = new URL(dashboardUrl);
  const returnTo = typeof value === 'string' ? new URL(value, base) : base;
  if (returnTo.origin !== base.origin)
    throw invalidRequest('The return URL is not allowed.');
  return returnTo.toString();
}

function cookieOptions(secure: boolean, maxAge?: number) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: '/',
    ...(maxAge === undefined ? {} : { maxAge }),
  };
}

function secondsUntil(iso: string): number {
  return Math.max(1, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
}

function requireIngestionStore(options: ApiApplicationOptions): IngestionStore {
  if (options.ingestionStore === undefined) {
    throw new HttpError(
      'internal_error',
      503,
      'Cloud ingestion storage is not configured.',
    );
  }
  return options.ingestionStore;
}

function requireWorkThreadStore(
  options: ApiApplicationOptions,
): WorkThreadStore {
  if (options.workThreadStore === undefined) {
    throw new HttpError(
      'internal_error',
      503,
      'Cloud work-thread storage is not configured.',
    );
  }
  return options.workThreadStore;
}

function requireRetrievalStore(options: ApiApplicationOptions): RetrievalStore {
  if (options.retrievalStore === undefined) {
    throw new HttpError(
      'internal_error',
      503,
      'Cloud retrieval storage is not configured.',
    );
  }
  return options.retrievalStore;
}

function requestContext(
  principal: AuthPrincipal,
  requestId: string,
): IngestionRequestContext {
  return { principal, requestId };
}

function requireUuid(value: string, label: string): void {
  if (!uuidPattern.test(value)) {
    throw invalidRequest(`The ${label} ID must be a UUID.`);
  }
}

function decodeIngestionBody(
  body: unknown,
  contentEncoding: string | string[] | undefined,
): unknown {
  if (!Buffer.isBuffer(body)) {
    throw invalidRequest('The ingestion body must be JSON.');
  }
  const encoding = (
    Array.isArray(contentEncoding)
      ? contentEncoding.join(',')
      : (contentEncoding ?? 'identity')
  )
    .trim()
    .toLowerCase();
  let decoded: Buffer;
  if (encoding === 'identity') {
    decoded = body;
  } else if (encoding === 'gzip') {
    try {
      decoded = gunzipSync(body, {
        maxOutputLength: maxIngestionDecompressedBytes,
      });
    } catch (error) {
      if (isBufferTooLargeError(error)) {
        throw new HttpError(
          'payload_too_large',
          413,
          'The decompressed ingestion batch exceeds the allowed byte limit.',
        );
      }
      throw invalidRequest('The gzip ingestion body is invalid.');
    }
  } else {
    throw new HttpError(
      'invalid_request',
      415,
      'Only identity and gzip content encodings are supported.',
    );
  }
  if (decoded.byteLength > maxIngestionDecompressedBytes) {
    throw new HttpError(
      'payload_too_large',
      413,
      'The decompressed ingestion batch exceeds the allowed byte limit.',
    );
  }
  try {
    return JSON.parse(decoded.toString('utf8')) as unknown;
  } catch {
    throw invalidRequest('The ingestion body is not valid JSON.');
  }
}

function isBufferTooLargeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ERR_BUFFER_TOO_LARGE'
  );
}

function isFastifyBodyLimitError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
  );
}

function isFastifyMediaTypeError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
  );
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
