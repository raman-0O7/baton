// Create a work thread for the captured llyod-ac-remote session so it shows on /work.
const API = (process.env.BATON_API_URL ?? 'http://localhost:4000').replace(
  /\/$/,
  '',
);
const email = process.env.SEED_EMAIL ?? 'you@baton.local';
const PROJECT = '45ab1b85-47b3-48a3-a385-046721923644';
const SESSION = '3f2713a4-21af-8728-8b7a-81b14ea831df';

async function json(res, label) {
  if (!res.ok) throw new Error(`${label} → ${res.status} ${await res.text()}`);
  return res.json();
}

// dev-login → cookie
const login = await fetch(
  `${API}/v1/auth/dev/login?email=${encodeURIComponent(email)}`,
  { redirect: 'manual' },
);
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
if (!cookie) throw new Error('no dev-login cookie — BATON_DEV_LOGIN=true?');
const cookieHeaders = { cookie, 'content-type': 'application/json' };

// device token (work:read + projects for thread ops)
const grant = await json(
  await fetch(`${API}/oauth/device/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: 'baton-cli',
      clientName: 'thread-llyod',
      clientVersion: '1',
      platform: 'node',
      requestedScopes: ['projects:read', 'projects:write', 'work:read'],
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
  'token',
);
const bearer = {
  authorization: `Bearer ${token.accessToken}`,
  'content-type': 'application/json',
};

// create thread + assign the captured session
const thread = await json(
  await fetch(`${API}/v1/work-threads`, {
    method: 'POST',
    headers: bearer,
    body: JSON.stringify({
      projectId: PROJECT,
      title: 'llyod-ac-remote — first captured session',
      goal: 'Captured Claude Code conversation for llyod-ac-remote',
    }),
  }),
  'create thread',
);
const assign = await fetch(
  `${API}/v1/work-threads/${thread.workThreadId}/sessions`,
  {
    method: 'POST',
    headers: bearer,
    body: JSON.stringify({ sourceSessionId: SESSION, assignment: 'confirmed' }),
  },
);
if (!assign.ok)
  throw new Error(`assign session → ${assign.status} ${await assign.text()}`);

console.log('thread created:', thread.workThreadId);
console.log('session assigned:', SESSION);
console.log('open: http://localhost:3000/work');
