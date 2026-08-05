import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';

import {
  AccountSchema,
  ApiProblemSchema,
  ConsentRecordSchema,
  ConsentListSchema,
  DeviceApprovalResponseSchema,
  DeviceAuthorizationResponseSchema,
  DeviceListSchema,
  IngestionAcknowledgementSchema,
  IngestionCheckpointSchema,
  ProjectListSchema,
  ProjectSchema,
  TokenResponseSchema,
  EventReadbackSchema,
  ProjectReindexResultSchema,
  RetrievalResultSchema,
  SourceSessionListSchema,
  ThreadContextSchema,
  ThreadSuggestionListSchema,
  WorkThreadListSchema,
  WorkThreadOverviewSchema,
  WorkThreadSchema,
  WorkThreadSessionListSchema,
  WorkThreadSessionSchema,
  maxIngestionCompressedBytes,
  maxIngestionDecompressedBytes,
  type Account,
  type ApiProblem,
  type AssignWorkThreadSessionRequest,
  type ConsentRecord,
  type CreateConsentRequest,
  type CreateProjectRequest,
  type CreateWorkThreadRequest,
  type Device,
  type DeviceAuthorizationRequest,
  type EventReadback,
  type IngestionAcknowledgement,
  type IngestionCheckpoint,
  type OAuthScope,
  type Project,
  type ProjectReindexResult,
  type RetrievalResult,
  type SourceSession,
  type ThreadContext,
  type ThreadSuggestionList,
  type TokenRequest,
  type TokenResponse,
  type UpdateProjectRequest,
  type UpdateWorkThreadRequest,
  type WorkThread,
  type WorkThreadOverview,
  type WorkThreadSession,
} from '@baton/protocol';
import {
  encodeScrubbedUpload,
  type ScrubbedIngestionBatch,
} from '@baton/scrubber';

const gzip = promisify(gzipCallback);

export class CloudApiError extends Error {
  constructor(readonly problem: ApiProblem) {
    super(problem.detail ?? problem.title);
    this.name = 'CloudApiError';
  }
}

export interface CloudClientOptions {
  baseUrl: string;
  fetcher?: typeof fetch;
}

export interface PreparedIngestionUpload {
  batchId: string;
  idempotencyKey: string;
  contentEncoding: 'gzip';
  body: Uint8Array;
}

export class BatonCloudClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: CloudClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetcher = options.fetcher ?? fetch;
  }

  beginDeviceAuthorization(input: DeviceAuthorizationRequest) {
    return this.request(
      '/oauth/device/authorize',
      DeviceAuthorizationResponseSchema,
      {
        method: 'POST',
        body: input,
      },
    );
  }

  exchangeToken(input: TokenRequest): Promise<TokenResponse> {
    return this.request('/oauth/token', TokenResponseSchema, {
      method: 'POST',
      body: input,
    });
  }

  account(accessToken: string): Promise<Account> {
    return this.request('/v1/account', AccountSchema, { accessToken });
  }

  async devices(accessToken: string): Promise<Device[]> {
    return (
      await this.request('/v1/devices', DeviceListSchema, {
        accessToken,
      })
    ).devices;
  }

  async projects(accessToken: string): Promise<Project[]> {
    return (
      await this.request('/v1/projects', ProjectListSchema, { accessToken })
    ).projects;
  }

  createProject(
    input: CreateProjectRequest,
    accessToken: string,
  ): Promise<Project> {
    return this.request('/v1/projects', ProjectSchema, {
      method: 'POST',
      accessToken,
      body: input,
    });
  }

  updateProject(
    projectId: string,
    input: UpdateProjectRequest,
    accessToken: string,
  ): Promise<Project> {
    return this.request(
      `/v1/projects/${encodeURIComponent(projectId)}`,
      ProjectSchema,
      { method: 'PATCH', accessToken, body: input },
    );
  }

  recordConsent(
    projectId: string,
    input: CreateConsentRequest,
    accessToken: string,
  ): Promise<ConsentRecord> {
    return this.request(
      `/v1/projects/${encodeURIComponent(projectId)}/consents`,
      ConsentRecordSchema,
      { method: 'POST', accessToken, body: input },
    );
  }

  async consents(
    projectId: string,
    accessToken: string,
  ): Promise<ConsentRecord[]> {
    return (
      await this.request(
        `/v1/projects/${encodeURIComponent(projectId)}/consents`,
        ConsentListSchema,
        { accessToken },
      )
    ).consents;
  }

  async revokeConsent(
    projectId: string,
    consentRecordId: string,
    accessToken: string,
  ): Promise<void> {
    await this.requestEmpty(
      `/v1/projects/${encodeURIComponent(projectId)}/consents/${encodeURIComponent(consentRecordId)}`,
      { method: 'DELETE', accessToken },
    );
  }

  checkpoint(
    input: {
      projectId: string;
      projectInstallationId: string;
      sourceSessionId: string;
    },
    accessToken: string,
  ): Promise<IngestionCheckpoint | null> {
    return this.requestOptional(
      `/v1/ingestion/checkpoint?${new URLSearchParams(input).toString()}`,
      IngestionCheckpointSchema,
      { accessToken },
    );
  }

  async ingestBatch(
    scrubbed: ScrubbedIngestionBatch,
    accessToken: string,
  ): Promise<IngestionAcknowledgement> {
    const encoded = encodeScrubbedUpload(scrubbed);
    const decompressedBytes = Buffer.byteLength(encoded);
    if (decompressedBytes > maxIngestionDecompressedBytes) {
      throw localPayloadTooLarge(
        decompressedBytes,
        maxIngestionDecompressedBytes,
      );
    }
    const compressed = await gzip(encoded, { level: 6 });
    if (compressed.byteLength > maxIngestionCompressedBytes) {
      throw localPayloadTooLarge(
        compressed.byteLength,
        maxIngestionCompressedBytes,
      );
    }
    return this.uploadPrepared(
      {
        batchId: scrubbed.batch.batchId,
        idempotencyKey: scrubbed.batch.batchId,
        contentEncoding: 'gzip',
        body: compressed,
      },
      accessToken,
    );
  }

  uploadPrepared(
    upload: PreparedIngestionUpload,
    accessToken: string,
  ): Promise<IngestionAcknowledgement> {
    if (upload.idempotencyKey !== upload.batchId) {
      throw new TypeError('ingestion idempotency key must match the batch ID');
    }
    if (upload.body.byteLength > maxIngestionCompressedBytes) {
      throw localPayloadTooLarge(
        upload.body.byteLength,
        maxIngestionCompressedBytes,
      );
    }
    return this.request(
      '/v1/ingestion/batches',
      IngestionAcknowledgementSchema,
      {
        method: 'POST',
        accessToken,
        rawBody: Buffer.from(upload.body),
        headers: {
          'content-type': 'application/json',
          'content-encoding': upload.contentEncoding,
          'idempotency-key': upload.idempotencyKey,
        },
      },
    );
  }

  async workThreads(
    projectId: string,
    accessToken: string,
  ): Promise<WorkThread[]> {
    return (
      await this.request(
        `/v1/work-threads?${new URLSearchParams({ projectId }).toString()}`,
        WorkThreadListSchema,
        { accessToken },
      )
    ).workThreads;
  }

  createWorkThread(
    input: CreateWorkThreadRequest,
    accessToken: string,
  ): Promise<WorkThread> {
    return this.request('/v1/work-threads', WorkThreadSchema, {
      method: 'POST',
      accessToken,
      body: input,
    });
  }

  updateWorkThread(
    workThreadId: string,
    input: UpdateWorkThreadRequest,
    accessToken: string,
  ): Promise<WorkThread> {
    return this.request(
      `/v1/work-threads/${encodeURIComponent(workThreadId)}`,
      WorkThreadSchema,
      { method: 'PATCH', accessToken, body: input },
    );
  }

  async workThreadSessions(
    workThreadId: string,
    accessToken: string,
  ): Promise<WorkThreadSession[]> {
    return (
      await this.request(
        `/v1/work-threads/${encodeURIComponent(workThreadId)}/sessions`,
        WorkThreadSessionListSchema,
        { accessToken },
      )
    ).sessions;
  }

  assignThreadSession(
    workThreadId: string,
    input: AssignWorkThreadSessionRequest,
    accessToken: string,
  ): Promise<WorkThreadSession> {
    return this.request(
      `/v1/work-threads/${encodeURIComponent(workThreadId)}/sessions`,
      WorkThreadSessionSchema,
      { method: 'POST', accessToken, body: input },
    );
  }

  async removeThreadSession(
    workThreadId: string,
    sourceSessionId: string,
    accessToken: string,
  ): Promise<void> {
    await this.requestEmpty(
      `/v1/work-threads/${encodeURIComponent(workThreadId)}/sessions/${encodeURIComponent(sourceSessionId)}`,
      { method: 'DELETE', accessToken },
    );
  }

  workThreadEvents(
    workThreadId: string,
    query: { cursor?: string | null; limit?: number },
    accessToken: string,
  ): Promise<EventReadback> {
    const params = new URLSearchParams();
    if (query.cursor != null) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.toString();
    return this.request(
      `/v1/work-threads/${encodeURIComponent(workThreadId)}/events${suffix === '' ? '' : `?${suffix}`}`,
      EventReadbackSchema,
      { accessToken },
    );
  }

  workThreadOverview(
    workThreadId: string,
    accessToken: string,
  ): Promise<WorkThreadOverview> {
    return this.request(
      `/v1/work-threads/${encodeURIComponent(workThreadId)}/overview`,
      WorkThreadOverviewSchema,
      { accessToken },
    );
  }

  async projectSourceSessions(
    projectId: string,
    accessToken: string,
  ): Promise<SourceSession[]> {
    return (
      await this.request(
        `/v1/projects/${encodeURIComponent(projectId)}/source-sessions`,
        SourceSessionListSchema,
        { accessToken },
      )
    ).sourceSessions;
  }

  suggestThreads(
    projectId: string,
    sourceSessionId: string | null,
    accessToken: string,
  ): Promise<ThreadSuggestionList> {
    const params = new URLSearchParams();
    if (sourceSessionId !== null)
      params.set('sourceSessionId', sourceSessionId);
    const suffix = params.toString();
    return this.request(
      `/v1/projects/${encodeURIComponent(projectId)}/thread-suggestions${suffix === '' ? '' : `?${suffix}`}`,
      ThreadSuggestionListSchema,
      { accessToken },
    );
  }

  reindexProject(
    projectId: string,
    accessToken: string,
  ): Promise<ProjectReindexResult> {
    return this.request(
      `/v1/projects/${encodeURIComponent(projectId)}/reindex`,
      ProjectReindexResultSchema,
      { method: 'POST', accessToken },
    );
  }

  searchRetrieval(
    input: {
      projectId: string;
      workThreadId?: string;
      query: string;
      limit?: number;
    },
    accessToken: string,
  ): Promise<RetrievalResult> {
    const params = new URLSearchParams({
      projectId: input.projectId,
      query: input.query,
    });
    if (input.workThreadId !== undefined)
      params.set('workThreadId', input.workThreadId);
    if (input.limit !== undefined) params.set('limit', String(input.limit));
    return this.request(
      `/v1/retrieval/search?${params.toString()}`,
      RetrievalResultSchema,
      { accessToken },
    );
  }

  workThreadContext(
    workThreadId: string,
    options: { query?: string; tokenBudget?: number },
    accessToken: string,
  ): Promise<ThreadContext> {
    const params = new URLSearchParams();
    if (options.query !== undefined) params.set('query', options.query);
    if (options.tokenBudget !== undefined)
      params.set('tokenBudget', String(options.tokenBudget));
    const suffix = params.toString();
    return this.request(
      `/v1/work-threads/${encodeURIComponent(workThreadId)}/context${suffix === '' ? '' : `?${suffix}`}`,
      ThreadContextSchema,
      { accessToken },
    );
  }

  approveDevice(userCode: string, browserCookie: string) {
    return this.request(
      '/v1/auth/device/approve',
      DeviceApprovalResponseSchema,
      {
        method: 'POST',
        browserCookie,
        body: { userCode },
      },
    );
  }

  async revokeDevice(deviceId: string, accessToken: string): Promise<void> {
    await this.requestEmpty(`/v1/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      accessToken,
    });
  }

  async logout(accessToken: string): Promise<void> {
    await this.requestEmpty('/v1/auth/logout', { method: 'POST', accessToken });
  }

  async health(): Promise<boolean> {
    const response = await this.fetcher(`${this.baseUrl}/health/ready`);
    return response.ok;
  }

  private async request<T>(
    path: string,
    schema: { parse(value: unknown): T },
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.fetcher(
      `${this.baseUrl}${path}`,
      requestInit(options),
    );
    const payload = await readJson(response);
    if (!response.ok) throw cloudError(response, payload);
    return schema.parse(payload);
  }

  private async requestOptional<T>(
    path: string,
    schema: { parse(value: unknown): T },
    options: RequestOptions = {},
  ): Promise<T | null> {
    const response = await this.fetcher(
      `${this.baseUrl}${path}`,
      requestInit(options),
    );
    if (response.status === 204) return null;
    const payload = await readJson(response);
    if (!response.ok) throw cloudError(response, payload);
    return schema.parse(payload);
  }

  private async requestEmpty(
    path: string,
    options: RequestOptions,
  ): Promise<void> {
    const response = await this.fetcher(
      `${this.baseUrl}${path}`,
      requestInit(options),
    );
    if (!response.ok) throw cloudError(response, await readJson(response));
  }
}

export function scopesForCli(): OAuthScope[] {
  return [
    'account:read',
    'devices:read',
    'devices:write',
    'projects:read',
    'projects:write',
    'ingest:write',
    'work:read',
  ];
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  accessToken?: string;
  browserCookie?: string;
  body?: unknown;
  rawBody?: Exclude<RequestInit['body'], null>;
  headers?: ConstructorParameters<typeof Headers>[0];
}

function requestInit(options: RequestOptions): RequestInit {
  const headers = new Headers({ accept: 'application/json' });
  if (options.accessToken !== undefined) {
    headers.set('authorization', `Bearer ${options.accessToken}`);
  }
  if (options.browserCookie !== undefined)
    headers.set('cookie', options.browserCookie);
  if (options.body !== undefined)
    headers.set('content-type', 'application/json');
  if (options.headers !== undefined) {
    new Headers(options.headers).forEach((value, key) =>
      headers.set(key, value),
    );
  }
  return {
    method: options.method ?? 'GET',
    headers,
    ...(options.rawBody !== undefined
      ? { body: options.rawBody }
      : options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return null;
  return response.json();
}

function cloudError(response: Response, payload: unknown): CloudApiError {
  const parsed = ApiProblemSchema.safeParse(payload);
  if (parsed.success) return new CloudApiError(parsed.data);
  return new CloudApiError({
    type: 'https://baton.dev/problems/cloud-request-failed',
    title: 'Cloud request failed',
    status:
      response.status >= 400 && response.status <= 599 ? response.status : 500,
    code: 'internal_error',
    detail: `Baton Cloud returned HTTP ${response.status}.`,
    requestId: response.headers.get('x-request-id') ?? 'unknown',
  });
}

function localPayloadTooLarge(actual: number, maximum: number): CloudApiError {
  return new CloudApiError({
    type: 'https://baton.dev/problems/payload-too-large',
    title: 'Payload too large',
    status: 413,
    code: 'payload_too_large',
    detail: `The encoded batch is ${actual} bytes; the limit is ${maximum} bytes.`,
    requestId: 'local',
  });
}
