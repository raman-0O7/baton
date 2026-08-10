// Populate a local Baton with demo data so the dashboard shows real content.
// Requires the API running with BATON_DEV_LOGIN=true. Usage:
//   node scripts/seed-demo.mjs            (email defaults to you@baton.local)
//   SEED_EMAIL=me@baton.local BATON_API_URL=http://localhost:4000 node scripts/seed-demo.mjs
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import {
  createSourceEvent,
  currentCollectionDisclosureDigest,
  currentCollectionDisclosureVersion,
} from '../packages/protocol/dist/index.js';

const API = (process.env.BATON_API_URL ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);
const email = process.env.SEED_EMAIL ?? 'you@baton.local';

const policy = {
  policyVersion: 'seed-v1',
  allowedCategories: [
    'conversation_text',
    'plans_and_tasks',
    'command_arguments',
    'tool_results',
    'file_paths',
    'diffs',
    'session_metadata',
  ],
  excludedPathPatterns: [],
  maxToolResultBytes: 8192,
  maxDiffBytes: 8192,
};

async function json(response, label) {
  if (!response.ok) {
    throw new Error(`${label} → ${response.status} ${await response.text()}`);
  }
  return response.json();
}

// 1. Dev login → browser session cookie.
const login = await fetch(
  `${API}/v1/auth/dev/login?email=${encodeURIComponent(email)}`,
  { redirect: 'manual' },
);
const setCookie = login.headers.get('set-cookie');
if (!setCookie) throw new Error('dev login returned no cookie — is BATON_DEV_LOGIN=true?');
const cookie = setCookie.split(';')[0];
const cookieHeaders = { cookie, 'content-type': 'application/json' };

// 2. Register a device (ingestion needs a device credential).
const grant = await json(
  await fetch(`${API}/oauth/device/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: 'baton-cli',
      clientName: 'seed-script',
      clientVersion: 'seed',
      platform: 'node',
      requestedScopes: [
        'projects:read',
        'projects:write',
        'ingest:write',
        'work:read',
      ],
    }),
  }),
  'device authorize',
);
await fetch(`${API}/v1/auth/device/approve`, {
  method: 'POST',
  headers: cookieHeaders,
  body: JSON.stringify({ userCode: grant.userCode }),
});
const token = await json(
  await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      clientId: 'baton-cli',
      deviceCode: grant.deviceCode,
    }),
  }),
  'token exchange',
);
const bearer = {
  authorization: `Bearer ${token.accessToken}`,
  'content-type': 'application/json',
};

// 3. Project + consent + a captured session (Claude), ingested as events.
const project = await json(
  await fetch(`${API}/v1/projects`, {
    method: 'POST',
    headers: bearer,
    body: JSON.stringify({ displayName: 'Greeting demo', collectionPolicy: policy }),
  }),
  'create project',
);
const installationId = randomUUID();
const consent = await json(
  await fetch(`${API}/v1/projects/${project.projectId}/consents`, {
    method: 'POST',
    headers: bearer,
    body: JSON.stringify({
      projectInstallationId: installationId,
      disclosureVersion: currentCollectionDisclosureVersion,
      disclosureDigest: currentCollectionDisclosureDigest,
      collectionPolicy: policy,
      cloudProcessingAcknowledged: true,
      modelProcessingAcknowledged: true,
      captureSurface: 'cli',
      historicalImport: false,
    }),
  }),
  'record consent',
);
const sessionId = randomUUID();
const base = Date.now() - 60 * 60 * 1000;
const payloads = [
  { kind: 'session_metadata', title: 'Add greeting helper', gitBranch: 'feat/greeting' },
  { kind: 'message', role: 'user', text: 'Create greet.go with a Greet function, then rename it to Hello.' },
  { kind: 'file_change', path: 'greet.go', operation: 'create', summary: 'new file' },
  { kind: 'file_change', path: 'greet.go', operation: 'edit', summary: 'renamed Greet to Hello' },
  { kind: 'decision', summary: 'Rename Greet to Hello for a clearer API', rationale: 'Reads better at call sites' },
  { kind: 'task', text: 'Add unit tests for Hello', status: 'pending' },
  { kind: 'message', role: 'assistant', text: 'Done: greet.go created and the function renamed to Hello. Unit tests remain as a follow-up.' },
];
const events = payloads.map((payload, index) =>
  createSourceEvent({
    sourceSessionId: sessionId,
    workThreadId: null,
    sourceAgent: 'claudecode',
    sourceDeviceId: token.deviceId,
    nativeSequence: index,
    parentEventId: null,
    occurredAt: new Date(base + index * 1000).toISOString(),
    observedAt: new Date(base + index * 1000).toISOString(),
    schemaVersion: 1,
    payload,
  }),
);
const batch = {
  schemaVersion: 1,
  batchId: randomUUID(),
  deviceId: token.deviceId,
  projectId: project.projectId,
  projectInstallationId: installationId,
  consentRecordId: consent.consentRecordId,
  policyVersion: policy.policyVersion,
  disclosureVersion: currentCollectionDisclosureVersion,
  source: {
    sourceSessionId: sessionId,
    agent: 'claudecode',
    nativeSessionHash: 'a'.repeat(64),
    parserVersion: 'seed-v1',
  },
  expectedHeadEventId: null,
  previousCursor: null,
  proposedCursor: 'cursor:1',
  events,
};
const ingest = await fetch(`${API}/v1/ingestion/batches`, {
  method: 'POST',
  headers: {
    ...bearer,
    'content-encoding': 'gzip',
  },
  body: gzipSync(Buffer.from(JSON.stringify(batch))),
});
if (ingest.status !== 202) {
  throw new Error(`ingest → ${ingest.status} ${await ingest.text()}`);
}

// 4. A work thread with the session assigned.
const thread = await json(
  await fetch(`${API}/v1/work-threads`, {
    method: 'POST',
    headers: bearer,
    body: JSON.stringify({
      projectId: project.projectId,
      title: 'Add greeting helper with tests',
      goal: 'Introduce a Hello greeting and cover it with tests',
    }),
  }),
  'create thread',
);
await fetch(`${API}/v1/work-threads/${thread.workThreadId}/sessions`, {
  method: 'POST',
  headers: bearer,
  body: JSON.stringify({ sourceSessionId: sessionId, assignment: 'confirmed' }),
});

// 5. A memory candidate awaiting approval (uses the browser session).
await fetch(`${API}/v1/memory/candidates`, {
  method: 'POST',
  headers: cookieHeaders,
  body: JSON.stringify({
    category: 'communication_preference',
    claim: 'Prefers concise answers by default.',
    scope: { type: 'global', id: null },
    evidence: [
      { eventId: randomUUID(), projectId: 'project-a', workThreadId: null, text: 'Keep your answers concise.' },
      { eventId: randomUUID(), projectId: 'project-b', workThreadId: null, text: 'Please keep this concise too.' },
    ],
  }),
});

console.log('Seeded Baton for', email);
console.log('  project     :', project.projectId, '(Greeting demo)');
console.log('  work thread :', thread.workThreadId, '(7 events)');
console.log('  memory      : one candidate awaiting approval');
console.log('');
console.log('Open the dashboard:');
console.log(`  1. ${API}/v1/auth/dev/login?email=${encodeURIComponent(email)}`);
console.log('  2. http://localhost:3000/work    → your thread + timeline + search');
console.log('  3. http://localhost:3000/memory  → approve the candidate');
console.log('  4. http://localhost:3000/privacy → export or delete');
