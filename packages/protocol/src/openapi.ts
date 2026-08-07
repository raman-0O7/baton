import { z } from 'zod';

import {
  AccountSchema,
  DeviceAuthorizationRequestSchema,
  DeviceAuthorizationResponseSchema,
  DeviceApprovalRequestSchema,
  DeviceApprovalResponseSchema,
  DeviceListSchema,
  DeviceSchema,
  TokenRequestSchema,
  TokenResponseSchema,
} from './auth.js';
import { ApiProblemSchema } from './errors.js';
import { SourceEventSchema } from './event.js';
import {
  ApproveMemoryRequestSchema,
  MemoryCandidateListSchema,
  MemoryCandidateSchema,
  MemoryListSchema,
  MemorySchema,
  ProposeMemoryRequestSchema,
  SoulDocumentSchema,
} from './memory.js';
import {
  IngestionAcknowledgementSchema,
  IngestionBatchSchema,
  IngestionCheckpointSchema,
} from './ingestion.js';
import {
  ConsentListSchema,
  ConsentRecordSchema,
  CreateConsentRequestSchema,
  CreateProjectRequestSchema,
  ProjectListSchema,
  ProjectSchema,
  UpdateProjectRequestSchema,
} from './project.js';
import { EventReadbackSchema } from './readback.js';
import {
  ProjectReindexResultSchema,
  RetrievalResultSchema,
  ThreadContextSchema,
} from './retrieval.js';
import { WorkThreadOverviewSchema } from './thread-overview.js';
import { ThreadSuggestionListSchema } from './thread-suggestion.js';
import {
  AssignWorkThreadSessionRequestSchema,
  CreateWorkThreadRequestSchema,
  SourceSessionListSchema,
  SourceSessionSchema,
  UpdateWorkThreadRequestSchema,
  WorkThreadListSchema,
  WorkThreadSchema,
  WorkThreadSessionListSchema,
  WorkThreadSessionSchema,
} from './work-thread.js';

export function createOpenApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Baton Cloud API',
      version: '1.0.0-alpha.3',
      description:
        'Versioned transport contract for normalized Baton conversation events.',
    },
    servers: [{ url: 'https://api.baton.dev' }],
    paths: {
      '/v1/auth/web/login': {
        get: {
          operationId: 'beginWebLogin',
          summary: 'Redirect a browser to the configured OIDC provider',
          parameters: [returnToQueryParameter()],
          responses: {
            '302': redirectResponse('Redirect to the identity provider.'),
            '503': problemResponse('Hosted web identity is not configured.'),
          },
        },
      },
      '/v1/auth/web/callback': {
        get: {
          operationId: 'completeWebLogin',
          summary: 'Complete OIDC login and establish a browser session',
          parameters: [
            requiredStringQueryParameter('code', 4096),
            requiredStringQueryParameter('state', 512),
          ],
          responses: {
            '302': redirectResponse('The browser session was established.'),
            '400': problemResponse(
              'The login state or authorization code is invalid.',
            ),
            '401': problemResponse('The identity provider rejected login.'),
          },
        },
      },
      '/v1/auth/device/approve': {
        post: {
          operationId: 'approveDeviceAuthorization',
          summary: 'Approve a displayed device code from a browser session',
          security: [{ BrowserSession: [] }],
          requestBody: jsonRequest('DeviceApprovalRequest'),
          responses: {
            '200': jsonResponse(
              'The device was approved.',
              'DeviceApprovalResponse',
            ),
            '400': problemResponse('The user code is invalid or expired.'),
            '401': problemResponse('A valid browser session is required.'),
            '409': problemResponse('The device grant was already completed.'),
          },
        },
      },
      '/v1/auth/logout': {
        post: {
          operationId: 'logout',
          summary: 'Revoke the current browser session or device',
          security: [{ BatonOAuth: [] }, { BrowserSession: [] }],
          responses: {
            '204': { description: 'The current credential was revoked.' },
            '401': problemResponse(
              'A valid session or access token is required.',
            ),
          },
        },
      },
      '/oauth/device/authorize': {
        post: {
          operationId: 'beginDeviceAuthorization',
          summary: 'Begin OAuth device authorization for a CLI',
          requestBody: jsonRequest('DeviceAuthorizationRequest'),
          responses: {
            '200': jsonResponse(
              'Device authorization was created.',
              'DeviceAuthorizationResponse',
            ),
            '400': problemResponse('The authorization request is invalid.'),
            '429': problemResponse('Too many authorization attempts.'),
          },
        },
      },
      '/oauth/token': {
        post: {
          operationId: 'exchangeDeviceOrRefreshToken',
          summary: 'Exchange a device code or rotate a refresh token',
          requestBody: jsonRequest('TokenRequest'),
          responses: {
            '200': jsonResponse('Tokens were issued.', 'TokenResponse'),
            '400': problemResponse('The grant is invalid or still pending.'),
            '401': problemResponse('The device grant was denied or expired.'),
            '429': problemResponse('The client is polling too quickly.'),
          },
        },
      },
      '/v1/devices': {
        get: {
          operationId: 'listDevices',
          summary: 'List devices registered to the current account',
          security: [{ BatonOAuth: ['devices:read'] }, { BrowserSession: [] }],
          responses: {
            '200': jsonResponse('Registered devices.', 'DeviceList'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the devices:read scope.',
            ),
          },
        },
      },
      '/v1/account': {
        get: {
          operationId: 'getCurrentAccount',
          summary: 'Read the authenticated account and tenant identity',
          security: [{ BatonOAuth: ['account:read'] }, { BrowserSession: [] }],
          responses: {
            '200': jsonResponse('The authenticated account.', 'Account'),
            '401': problemResponse(
              'A valid session or access token is required.',
            ),
            '403': problemResponse(
              'The access token is missing the account:read scope.',
            ),
          },
        },
      },
      '/v1/devices/{deviceId}': {
        delete: {
          operationId: 'revokeDevice',
          summary: 'Revoke one device and all of its credentials',
          security: [{ BatonOAuth: ['devices:write'] }, { BrowserSession: [] }],
          parameters: [uuidPathParameter('deviceId')],
          responses: {
            '204': { description: 'The device was revoked.' },
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the devices:write scope.',
            ),
            '404': problemResponse('The device was not found.'),
          },
        },
      },
      '/v1/projects': {
        get: {
          operationId: 'listProjects',
          summary: 'List projects visible to the current account',
          security: [{ BatonOAuth: ['projects:read'] }],
          responses: {
            '200': jsonResponse('Cloud projects.', 'ProjectList'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the projects:read scope.',
            ),
          },
        },
        post: {
          operationId: 'createProject',
          summary: 'Create an explicitly enabled cloud project',
          security: [{ BatonOAuth: ['projects:write'] }],
          requestBody: jsonRequest('CreateProjectRequest'),
          responses: {
            '201': jsonResponse('The project was created.', 'Project'),
            '400': problemResponse('The project request is invalid.'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the projects:write scope.',
            ),
            '409': problemResponse('An equivalent project already exists.'),
          },
        },
      },
      '/v1/projects/{projectId}': {
        patch: {
          operationId: 'updateProject',
          summary: 'Update project state or collection policy',
          security: [{ BatonOAuth: ['projects:write'] }],
          parameters: [uuidPathParameter('projectId')],
          requestBody: jsonRequest('UpdateProjectRequest'),
          responses: {
            '200': jsonResponse('The project was updated.', 'Project'),
            '400': problemResponse('The project update is invalid.'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the projects:write scope.',
            ),
            '404': problemResponse('The project was not found.'),
          },
        },
      },
      '/v1/projects/{projectId}/consents': {
        get: {
          operationId: 'listProjectConsents',
          summary: 'List consent history for a project',
          security: [{ BatonOAuth: ['projects:read'] }],
          parameters: [uuidPathParameter('projectId')],
          responses: {
            '200': jsonResponse('Project consent records.', 'ConsentList'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the projects:read scope.',
            ),
            '404': problemResponse('The project was not found.'),
          },
        },
        post: {
          operationId: 'recordProjectConsent',
          summary: 'Record affirmative project collection consent',
          security: [{ BatonOAuth: ['projects:write'] }],
          parameters: [uuidPathParameter('projectId')],
          requestBody: jsonRequest('CreateConsentRequest'),
          responses: {
            '201': jsonResponse('Consent was recorded.', 'ConsentRecord'),
            '400': problemResponse('The consent record is invalid.'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the projects:write scope.',
            ),
            '404': problemResponse('The project was not found.'),
            '409': problemResponse(
              'The disclosure or collection policy is stale.',
            ),
          },
        },
      },
      '/v1/projects/{projectId}/consents/{consentRecordId}': {
        delete: {
          operationId: 'revokeProjectConsent',
          summary: 'Revoke collection consent for one project installation',
          security: [{ BatonOAuth: ['projects:write'] }],
          parameters: [
            uuidPathParameter('projectId'),
            uuidPathParameter('consentRecordId'),
          ],
          responses: {
            '204': {
              description: 'Consent was revoked or was already revoked.',
            },
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the projects:write scope.',
            ),
            '404': problemResponse('The project or consent was not found.'),
          },
        },
      },
      '/v1/ingestion/batches': {
        post: {
          operationId: 'ingestEventBatch',
          summary: 'Idempotently ingest normalized source events',
          security: [{ BatonOAuth: ['ingest:write'] }],
          parameters: [contentEncodingHeaderParameter()],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/IngestionBatch' },
              },
            },
          },
          responses: {
            '202': {
              description: 'The batch was accepted or previously ingested.',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/IngestionAcknowledgement',
                  },
                },
              },
            },
            '400': problemResponse('Invalid ingestion request.'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the ingest:write scope.',
            ),
            '409': problemResponse('The source checkpoint has diverged.'),
            '413': problemResponse('The ingestion batch is too large.'),
            '415': problemResponse('The content encoding is not supported.'),
            '429': problemResponse('The ingestion rate limit was exceeded.'),
          },
        },
      },
      '/v1/ingestion/checkpoint': {
        get: {
          operationId: 'getIngestionCheckpoint',
          summary: 'Read the authenticated device checkpoint for one source',
          security: [{ BatonOAuth: ['ingest:write'] }],
          parameters: [
            uuidQueryParameter('projectId', true),
            uuidQueryParameter('projectInstallationId', true),
            uuidQueryParameter('sourceSessionId', true),
          ],
          responses: {
            '200': jsonResponse(
              'The current source checkpoint.',
              'IngestionCheckpoint',
            ),
            '204': { description: 'No checkpoint has been recorded.' },
            '400': problemResponse('The checkpoint query is invalid.'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the ingest:write scope.',
            ),
            '404': problemResponse('The project installation was not found.'),
          },
        },
      },
      '/v1/work-threads': {
        get: {
          operationId: 'listWorkThreads',
          summary: 'List work threads in a project',
          security: [{ BatonOAuth: ['work:read'] }],
          parameters: [uuidQueryParameter('projectId', true)],
          responses: {
            '200': jsonResponse('Project work threads.', 'WorkThreadList'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the work:read scope.',
            ),
            '404': problemResponse('The project was not found.'),
          },
        },
        post: {
          operationId: 'createWorkThread',
          summary: 'Create a work thread',
          security: [{ BatonOAuth: ['projects:write'] }],
          requestBody: jsonRequest('CreateWorkThreadRequest'),
          responses: {
            '201': jsonResponse('The work thread was created.', 'WorkThread'),
            '400': problemResponse('The work-thread request is invalid.'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the projects:write scope.',
            ),
            '404': problemResponse('The project was not found.'),
          },
        },
      },
      '/v1/work-threads/{workThreadId}': {
        patch: {
          operationId: 'updateWorkThread',
          summary: 'Rename a work thread or change its goal or state',
          security: [{ BatonOAuth: ['projects:write'] }],
          parameters: [uuidPathParameter('workThreadId')],
          requestBody: jsonRequest('UpdateWorkThreadRequest'),
          responses: {
            '200': jsonResponse('The work thread was updated.', 'WorkThread'),
            '400': problemResponse('The work-thread update is invalid.'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the projects:write scope.',
            ),
            '404': problemResponse('The work thread was not found.'),
          },
        },
      },
      '/v1/work-threads/{workThreadId}/overview': {
        get: {
          operationId: 'getWorkThreadOverview',
          summary: 'Read the materialized current state of a work thread',
          security: [{ BatonOAuth: ['work:read'] }],
          parameters: [uuidPathParameter('workThreadId')],
          responses: {
            '200': jsonResponse(
              'The materialized work-thread state.',
              'WorkThreadOverview',
            ),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the work:read scope.',
            ),
            '404': problemResponse('The work thread was not found.'),
          },
        },
      },
      '/v1/work-threads/{workThreadId}/sessions': {
        get: {
          operationId: 'listWorkThreadSessions',
          summary: 'List the source sessions assigned to a work thread',
          security: [{ BatonOAuth: ['work:read'] }],
          parameters: [uuidPathParameter('workThreadId')],
          responses: {
            '200': jsonResponse(
              'The assigned source sessions.',
              'WorkThreadSessionList',
            ),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the work:read scope.',
            ),
            '404': problemResponse('The work thread was not found.'),
          },
        },
        post: {
          operationId: 'assignWorkThreadSession',
          summary: 'Assign a source session to a work thread',
          security: [{ BatonOAuth: ['projects:write'] }],
          parameters: [uuidPathParameter('workThreadId')],
          requestBody: jsonRequest('AssignWorkThreadSessionRequest'),
          responses: {
            '201': jsonResponse(
              'The source session was assigned.',
              'WorkThreadSession',
            ),
            '400': problemResponse('The assignment request is invalid.'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the projects:write scope.',
            ),
            '404': problemResponse(
              'The work thread or source session was not found.',
            ),
            '409': problemResponse(
              'The source session is already assigned to another thread.',
            ),
          },
        },
      },
      '/v1/work-threads/{workThreadId}/sessions/{sourceSessionId}': {
        delete: {
          operationId: 'removeWorkThreadSession',
          summary: 'Remove a source session from a work thread',
          security: [{ BatonOAuth: ['projects:write'] }],
          parameters: [
            uuidPathParameter('workThreadId'),
            uuidPathParameter('sourceSessionId'),
          ],
          responses: {
            '204': {
              description: 'The source session was removed or was not present.',
            },
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the projects:write scope.',
            ),
            '404': problemResponse('The work thread was not found.'),
          },
        },
      },
      '/v1/work-threads/{workThreadId}/events': {
        get: {
          operationId: 'readWorkThreadEvents',
          summary: 'Read a bounded page of normalized work-thread events',
          security: [{ BatonOAuth: ['work:read'] }],
          parameters: [
            uuidPathParameter('workThreadId'),
            cursorQueryParameter(),
            limitQueryParameter(),
          ],
          responses: {
            '200': jsonResponse(
              'A page of normalized events.',
              'EventReadback',
            ),
            '400': problemResponse('The read cursor or limit is invalid.'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the work:read scope.',
            ),
            '404': problemResponse('The work thread was not found.'),
          },
        },
      },
      '/v1/projects/{projectId}/source-sessions': {
        get: {
          operationId: 'listProjectSourceSessions',
          summary: 'List captured source sessions in a project',
          security: [{ BatonOAuth: ['work:read'] }],
          parameters: [uuidPathParameter('projectId')],
          responses: {
            '200': jsonResponse(
              'Captured source sessions.',
              'SourceSessionList',
            ),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the work:read scope.',
            ),
            '404': problemResponse('The project was not found.'),
          },
        },
      },
      '/v1/projects/{projectId}/reindex': {
        post: {
          operationId: 'reindexProject',
          summary: 'Materialize the retrieval chunk index for a project',
          security: [{ BatonOAuth: ['projects:write'] }],
          parameters: [uuidPathParameter('projectId')],
          responses: {
            '200': jsonResponse(
              'The project retrieval index was refreshed.',
              'ProjectReindexResult',
            ),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the projects:write scope.',
            ),
            '404': problemResponse('The project was not found.'),
          },
        },
      },
      '/v1/retrieval/search': {
        get: {
          operationId: 'searchRetrieval',
          summary: 'Lexically search normalized chunks within a project',
          security: [{ BatonOAuth: ['work:read'] }],
          parameters: [
            uuidQueryParameter('projectId', true),
            uuidQueryParameter('workThreadId', false),
            requiredStringQueryParameter('query', 1024),
            limitQueryParameter(),
          ],
          responses: {
            '200': jsonResponse('Ranked retrieval chunks.', 'RetrievalResult'),
            '400': problemResponse('The search query is invalid.'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the work:read scope.',
            ),
            '404': problemResponse('The project was not found.'),
          },
        },
      },
      '/v1/work-threads/{workThreadId}/context': {
        get: {
          operationId: 'compileWorkThreadContext',
          summary:
            'Compile a budgeted, cited continuation context for a thread',
          security: [{ BatonOAuth: ['work:read'] }],
          parameters: [
            uuidPathParameter('workThreadId'),
            optionalStringQueryParameter('query', 1024),
            tokenBudgetQueryParameter(),
          ],
          responses: {
            '200': jsonResponse(
              'A compiled thread bootstrap and cited evidence.',
              'ThreadContext',
            ),
            '400': problemResponse('The context query is invalid.'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the work:read scope.',
            ),
            '404': problemResponse('The work thread was not found.'),
          },
        },
      },
      '/v1/projects/{projectId}/thread-suggestions': {
        get: {
          operationId: 'suggestProjectThreads',
          summary: 'Rank existing work threads a source session may continue',
          security: [{ BatonOAuth: ['work:read'] }],
          parameters: [
            uuidPathParameter('projectId'),
            uuidQueryParameter('sourceSessionId', false),
          ],
          responses: {
            '200': jsonResponse(
              'Ranked work-thread suggestions.',
              'ThreadSuggestionList',
            ),
            '400': problemResponse('The suggestion query is invalid.'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the work:read scope.',
            ),
            '404': problemResponse(
              'The project or source session was not found.',
            ),
          },
        },
      },
      '/v1/memory/candidates': {
        get: {
          operationId: 'listMemoryCandidates',
          summary: 'List personal memory candidates awaiting review',
          security: [{ BatonOAuth: ['memory:write'] }],
          parameters: [
            {
              name: 'status',
              in: 'query',
              required: false,
              schema: {
                type: 'string',
                enum: ['proposed', 'needs_review', 'approved', 'rejected'],
              },
            },
          ],
          responses: {
            '200': jsonResponse('Memory candidates.', 'MemoryCandidateList'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the memory:write scope.',
            ),
          },
        },
        post: {
          operationId: 'proposeMemory',
          summary: 'Propose a personal memory candidate from evidence',
          security: [{ BatonOAuth: ['memory:write'] }],
          requestBody: jsonRequest('ProposeMemoryRequest'),
          responses: {
            '201': jsonResponse(
              'The validated candidate (which may be rejected).',
              'MemoryCandidate',
            ),
            '400': problemResponse('The proposal is invalid.'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the memory:write scope.',
            ),
          },
        },
      },
      '/v1/memory/candidates/{candidateId}/approve': {
        post: {
          operationId: 'approveMemory',
          summary: 'Approve a candidate into an evidence-backed memory',
          security: [{ BatonOAuth: ['memory:write'] }],
          parameters: [uuidPathParameter('candidateId')],
          requestBody: jsonRequest('ApproveMemoryRequest'),
          responses: {
            '201': jsonResponse('The approved memory.', 'Memory'),
            '400': problemResponse(
              'The claim is a prohibited sensitive inference.',
            ),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the memory:write scope.',
            ),
            '404': problemResponse('The candidate was not found.'),
            '409': problemResponse('The candidate cannot be approved.'),
          },
        },
      },
      '/v1/memory/candidates/{candidateId}/reject': {
        post: {
          operationId: 'rejectMemory',
          summary: 'Reject a memory candidate',
          security: [{ BatonOAuth: ['memory:write'] }],
          parameters: [uuidPathParameter('candidateId')],
          responses: {
            '204': { description: 'The candidate was rejected.' },
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the memory:write scope.',
            ),
            '404': problemResponse('The candidate was not found.'),
          },
        },
      },
      '/v1/memory/memories': {
        get: {
          operationId: 'listApprovedMemories',
          summary: 'List approved, unexpired personal memories',
          security: [{ BatonOAuth: ['memory:read'] }],
          responses: {
            '200': jsonResponse('Approved memories.', 'MemoryList'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the memory:read scope.',
            ),
          },
        },
      },
      '/v1/memory/soul': {
        get: {
          operationId: 'renderSoul',
          summary: 'Render approved memories as a budgeted SOUL document',
          security: [{ BatonOAuth: ['memory:read'] }],
          parameters: [tokenBudgetQueryParameter()],
          responses: {
            '200': jsonResponse('The rendered SOUL document.', 'SoulDocument'),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              'The access token is missing the memory:read scope.',
            ),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        BrowserSession: {
          type: 'apiKey',
          in: 'cookie',
          name: '__Host-baton_session',
          description: 'Secure, HTTP-only hosted dashboard session.',
        },
        BatonOAuth: {
          type: 'oauth2',
          description:
            'OAuth 2.0 bearer access token issued to a Baton CLI or web client.',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://app.baton.dev/oauth/authorize',
              tokenUrl: 'https://api.baton.dev/oauth/token',
              scopes: {
                'account:read': 'Read the current Baton account.',
                'devices:read': 'List registered Baton devices.',
                'devices:write': 'Rename or revoke registered Baton devices.',
                'projects:read': 'Read explicitly enabled cloud projects.',
                'projects:write':
                  'Create projects and manage collection consent.',
                'ingest:write':
                  'Upload normalized events for enabled projects.',
                'work:read': 'Read work threads and normalized evidence.',
                'memory:read': 'Read approved personal memories.',
                'memory:write':
                  'Propose, approve, edit, and revoke personal memories.',
              },
            },
          },
        },
      },
      schemas: {
        Account: componentSchema(AccountSchema),
        DeviceAuthorizationRequest: componentSchema(
          DeviceAuthorizationRequestSchema,
        ),
        DeviceAuthorizationResponse: componentSchema(
          DeviceAuthorizationResponseSchema,
        ),
        DeviceApprovalRequest: componentSchema(DeviceApprovalRequestSchema),
        DeviceApprovalResponse: componentSchema(DeviceApprovalResponseSchema),
        TokenRequest: componentSchema(TokenRequestSchema),
        TokenResponse: componentSchema(TokenResponseSchema),
        Device: componentSchema(DeviceSchema),
        DeviceList: componentSchema(DeviceListSchema),
        Project: componentSchema(ProjectSchema),
        ProjectList: componentSchema(ProjectListSchema),
        CreateProjectRequest: componentSchema(CreateProjectRequestSchema),
        UpdateProjectRequest: componentSchema(UpdateProjectRequestSchema),
        CreateConsentRequest: componentSchema(CreateConsentRequestSchema),
        ConsentRecord: componentSchema(ConsentRecordSchema),
        ConsentList: componentSchema(ConsentListSchema),
        SourceEvent: componentSchema(SourceEventSchema),
        IngestionBatch: componentSchema(IngestionBatchSchema),
        IngestionAcknowledgement: componentSchema(
          IngestionAcknowledgementSchema,
        ),
        IngestionCheckpoint: componentSchema(IngestionCheckpointSchema),
        WorkThread: componentSchema(WorkThreadSchema),
        WorkThreadList: componentSchema(WorkThreadListSchema),
        CreateWorkThreadRequest: componentSchema(CreateWorkThreadRequestSchema),
        UpdateWorkThreadRequest: componentSchema(UpdateWorkThreadRequestSchema),
        SourceSession: componentSchema(SourceSessionSchema),
        SourceSessionList: componentSchema(SourceSessionListSchema),
        WorkThreadSession: componentSchema(WorkThreadSessionSchema),
        WorkThreadSessionList: componentSchema(WorkThreadSessionListSchema),
        AssignWorkThreadSessionRequest: componentSchema(
          AssignWorkThreadSessionRequestSchema,
        ),
        WorkThreadOverview: componentSchema(WorkThreadOverviewSchema),
        ThreadSuggestionList: componentSchema(ThreadSuggestionListSchema),
        RetrievalResult: componentSchema(RetrievalResultSchema),
        ThreadContext: componentSchema(ThreadContextSchema),
        ProjectReindexResult: componentSchema(ProjectReindexResultSchema),
        ProposeMemoryRequest: componentSchema(ProposeMemoryRequestSchema),
        ApproveMemoryRequest: componentSchema(ApproveMemoryRequestSchema),
        MemoryCandidate: componentSchema(MemoryCandidateSchema),
        MemoryCandidateList: componentSchema(MemoryCandidateListSchema),
        Memory: componentSchema(MemorySchema),
        MemoryList: componentSchema(MemoryListSchema),
        SoulDocument: componentSchema(SoulDocumentSchema),
        EventReadback: componentSchema(EventReadbackSchema),
        ApiProblem: componentSchema(ApiProblemSchema),
      },
    },
  } as const;
}

function jsonRequest(componentName: string) {
  return {
    required: true,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${componentName}` },
      },
    },
  } as const;
}

function jsonResponse(description: string, componentName: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${componentName}` },
      },
    },
  } as const;
}

function uuidPathParameter(name: string) {
  return {
    name,
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  } as const;
}

function uuidQueryParameter(name: string, required: boolean) {
  return {
    name,
    in: 'query',
    required,
    schema: { type: 'string', format: 'uuid' },
  } as const;
}

function cursorQueryParameter() {
  return {
    name: 'cursor',
    in: 'query',
    required: false,
    schema: { type: 'string', minLength: 1, maxLength: 2048 },
  } as const;
}

function limitQueryParameter() {
  return {
    name: 'limit',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
  } as const;
}

function returnToQueryParameter() {
  return {
    name: 'returnTo',
    in: 'query',
    required: false,
    schema: { type: 'string', minLength: 1, maxLength: 2048 },
  } as const;
}

function requiredStringQueryParameter(name: string, maxLength: number) {
  return {
    name,
    in: 'query',
    required: true,
    schema: { type: 'string', minLength: 1, maxLength },
  } as const;
}

function optionalStringQueryParameter(name: string, maxLength: number) {
  return {
    name,
    in: 'query',
    required: false,
    schema: { type: 'string', minLength: 1, maxLength },
  } as const;
}

function tokenBudgetQueryParameter() {
  return {
    name: 'tokenBudget',
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum: 64, maximum: 8000, default: 2000 },
  } as const;
}

function contentEncodingHeaderParameter() {
  return {
    name: 'Content-Encoding',
    in: 'header',
    required: false,
    description:
      'Use gzip for bounded compressed ingestion; identity is accepted for small batches.',
    schema: { type: 'string', enum: ['identity', 'gzip'], default: 'identity' },
  } as const;
}

function redirectResponse(description: string) {
  return {
    description,
    headers: {
      Location: { schema: { type: 'string', format: 'uri' } },
      'Set-Cookie': { schema: { type: 'string' } },
    },
  } as const;
}

function componentSchema(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>;
  const { $schema: _dialect, ...component } = generated;
  return component;
}

function problemResponse(description: string) {
  return {
    description,
    content: {
      'application/problem+json': {
        schema: { $ref: '#/components/schemas/ApiProblem' },
      },
    },
  } as const;
}
