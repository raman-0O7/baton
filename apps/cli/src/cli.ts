import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { platform, release } from 'node:os';

import {
  BatonCloudClient,
  CloudApiError,
  scopesForCli,
} from '@baton/cloud-client';
import type { AgentName } from '@baton/protocol';
import {
  COLLECTION_DISCLOSURE,
  COLLECTION_DISCLOSURE_DIGEST,
  COLLECTION_DISCLOSURE_VERSION,
  DEFAULT_COLLECTION_POLICY,
  IntervalReconciliationScheduler,
  SyncCoordinator,
  UploadFailure,
  detectLegacyGitConfiguration,
  type CloudUploader,
  type EventSource,
  type InstallationMap,
  type ProjectIdentity,
  type SourceChangeWatcher,
} from '@baton/sync';

import { createBatonMcpServer } from '@baton/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { CredentialStore, StoredCredentials } from './credentials.js';
import {
  createNativeSyncRuntime,
  type NativeSourceOptions,
} from './sync-runtime.js';

export interface CliIo {
  out(message: string): void;
  error(message: string): void;
}

export interface CliDependencies {
  apiUrl: string;
  store: CredentialStore;
  io: CliIo;
  createClient?: (baseUrl: string) => BatonCloudClient;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  cwd?: () => string;
  confirmEnable?: (prompt: string) => Promise<boolean>;
  waitForShutdown?: () => Promise<void>;
  syncRuntime?: CliSyncRuntime;
  nativeSourceOptions?: NativeSourceOptions;
}

export interface CliSyncRuntime {
  installations: InstallationMap;
  eventSources: EventSource[];
  detectedAgents: AgentName[];
  watcher?: SourceChangeWatcher;
}

export async function runCli(
  args: string[],
  dependencies: CliDependencies,
): Promise<number> {
  const command = args[0] ?? 'help';
  try {
    switch (command) {
      case 'login':
        await login(dependencies, optionValue(args, '--device-name'));
        return 0;
      case 'logout':
        await logout(dependencies);
        return 0;
      case 'whoami':
        await whoami(dependencies);
        return 0;
      case 'doctor':
        return doctor(dependencies);
      case 'enable':
        await enable(dependencies, args);
        return 0;
      case 'status':
        await status(dependencies, optionalPath(args, dependencies));
        return 0;
      case 'pause':
        await pause(dependencies, optionalPath(args, dependencies));
        return 0;
      case 'resume':
        await resume(dependencies, optionalPath(args, dependencies));
        return 0;
      case 'disable':
        await disable(dependencies, optionalPath(args, dependencies));
        return 0;
      case 'daemon':
        await daemon(dependencies);
        return 0;
      case 'continue':
        await continueThread(dependencies, args);
        return 0;
      case 'mcp':
        if (args[1] === 'install') {
          mcpInstall(dependencies, args[2]);
          return 0;
        }
        await mcpServe(dependencies);
        return 0;
      case 'help':
      case '--help':
      case '-h':
        printHelp(dependencies.io);
        return 0;
      default:
        dependencies.io.error(`Unknown command: ${command}`);
        printHelp(dependencies.io);
        return 2;
    }
  } catch (error) {
    dependencies.io.error(humanError(error));
    return 1;
  }
}

async function login(
  dependencies: CliDependencies,
  requestedName?: string,
): Promise<void> {
  const client = createClient(dependencies, dependencies.apiUrl);
  const grant = await client.beginDeviceAuthorization({
    clientId: 'baton-cli',
    clientName: requestedName ?? defaultDeviceName(),
    clientVersion: '0.1.0',
    platform: `${platform()} ${release()}`,
    requestedScopes: scopesForCli(),
  });
  dependencies.io.out('Open this URL to connect Baton:');
  dependencies.io.out(grant.verificationUriComplete);
  dependencies.io.out(`Confirmation code: ${grant.userCode}`);

  const sleep = dependencies.sleep ?? defaultSleep;
  const deadline = (dependencies.now ?? Date.now)() + grant.expiresIn * 1000;
  let interval = grant.interval;
  while ((dependencies.now ?? Date.now)() < deadline) {
    await sleep(interval * 1000);
    try {
      const tokens = await client.exchangeToken({
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        clientId: 'baton-cli',
        deviceCode: grant.deviceCode,
      });
      await dependencies.store.save({
        apiBaseUrl: dependencies.apiUrl,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: (dependencies.now ?? Date.now)() + tokens.expiresIn * 1000,
        userId: tokens.userId,
        tenantId: tokens.tenantId,
        deviceId: tokens.deviceId,
      });
      dependencies.io.out(`Connected as ${tokens.userId}.`);
      return;
    } catch (error) {
      if (
        error instanceof CloudApiError &&
        error.problem.code === 'authorization_pending'
      ) {
        interval = error.problem.retryAfterSeconds ?? interval;
        continue;
      }
      if (
        error instanceof CloudApiError &&
        error.problem.code === 'slow_down'
      ) {
        interval = error.problem.retryAfterSeconds ?? interval + 5;
        continue;
      }
      throw error;
    }
  }
  throw new Error('The login code expired. Run `baton login` to try again.');
}

async function logout(dependencies: CliDependencies): Promise<void> {
  const credentials = await dependencies.store.load();
  if (credentials === null) {
    dependencies.io.out('Already logged out.');
    return;
  }
  try {
    const active = await freshCredentials(dependencies, credentials);
    await createClient(dependencies, active.apiBaseUrl).logout(
      active.accessToken,
    );
  } catch (error) {
    if (!(error instanceof CloudApiError && error.problem.status === 401))
      throw error;
  }
  await dependencies.store.clear();
  dependencies.io.out('Logged out and removed local credentials.');
}

async function whoami(dependencies: CliDependencies): Promise<void> {
  const credentials = await requireCredentials(dependencies);
  const active = await freshCredentials(dependencies, credentials);
  const account = await createClient(dependencies, active.apiBaseUrl).account(
    active.accessToken,
  );
  dependencies.io.out(`${account.displayName} <${account.email}>`);
  dependencies.io.out(`Tenant: ${account.tenantId}`);
  dependencies.io.out(`Device: ${account.currentDeviceId ?? active.deviceId}`);
}

async function doctor(dependencies: CliDependencies): Promise<number> {
  dependencies.io.out(`API: ${dependencies.apiUrl}`);
  dependencies.io.out(`Credential store: ${dependencies.store.description}`);
  const reachable = await createClient(dependencies, dependencies.apiUrl)
    .health()
    .catch(() => false);
  dependencies.io.out(`Cloud reachability: ${reachable ? 'ok' : 'failed'}`);
  const credentials = await dependencies.store.load();
  if (credentials === null) {
    dependencies.io.out('Authentication: not logged in');
    await reportLegacyConfiguration(dependencies);
    return reachable ? 1 : 2;
  }
  try {
    const active = await freshCredentials(dependencies, credentials);
    await createClient(dependencies, active.apiBaseUrl).account(
      active.accessToken,
    );
    dependencies.io.out('Authentication: ok');
    await reportLegacyConfiguration(dependencies);
    return reachable ? 0 : 2;
  } catch {
    dependencies.io.out(
      'Authentication: expired or revoked; run `baton login`',
    );
    return 1;
  }
}

async function enable(
  dependencies: CliDependencies,
  args: string[],
): Promise<void> {
  const credentials = await freshCredentials(
    dependencies,
    await requireCredentials(dependencies),
  );
  const runtime = await syncRuntime(dependencies);
  const localPath = optionalPath(args, dependencies);
  const identified = await runtime.installations.identify(localPath);
  const existing = await runtime.installations.get(identified.projectIdentity);
  if (existing?.state === 'enabled') {
    throw new Error(`${existing.displayName} is already enabled.`);
  }
  if (existing?.state === 'paused') {
    throw new Error(`${existing.displayName} is paused. Run \`baton resume\`.`);
  }
  if (runtime.detectedAgents.length === 0) {
    throw new Error(
      'No supported agent installation was found (Claude Code, Codex, or OpenCode).',
    );
  }

  const displayName =
    optionValue(args, '--name') ??
    existing?.displayName ??
    basename(identified.canonicalLocalPath);
  printCollectionDisclosure(
    dependencies.io,
    displayName,
    runtime.detectedAgents,
  );
  const affirmative =
    args.includes('--yes') ||
    (await dependencies.confirmEnable?.(
      'Type ENABLE to start collecting only new conversations: ',
    )) === true;
  if (!affirmative) {
    throw new Error('Project enablement cancelled; nothing was collected.');
  }

  const client = createClient(dependencies, credentials.apiBaseUrl);
  const policy = structuredClone(DEFAULT_COLLECTION_POLICY);
  const project =
    existing === null
      ? await client.createProject(
          { displayName, collectionPolicy: policy },
          credentials.accessToken,
        )
      : await existingProject(
          client,
          existing.cloudProjectId,
          credentials.accessToken,
        );
  const projectInstallationId = existing?.projectInstallationId ?? randomUUID();
  const consent = await client.recordConsent(
    project.projectId,
    {
      projectInstallationId,
      disclosureVersion: COLLECTION_DISCLOSURE_VERSION,
      disclosureDigest: COLLECTION_DISCLOSURE_DIGEST,
      collectionPolicy: policy,
      cloudProcessingAcknowledged: true,
      modelProcessingAcknowledged: true,
      captureSurface: 'cli',
      historicalImport: false,
    },
    credentials.accessToken,
  );

  try {
    await runtime.installations.enable({
      localPath,
      projectInstallationId,
      cloudProjectId: project.projectId,
      deviceId: credentials.deviceId,
      displayName,
      detectedAgents: runtime.detectedAgents,
      consentRecordId: consent.consentRecordId,
      collectionPolicy: policy,
      disclosureVersion: COLLECTION_DISCLOSURE_VERSION,
      disclosureDigest: COLLECTION_DISCLOSURE_DIGEST,
      cloudProcessingAcknowledged: true,
      modelProcessingAcknowledged: true,
      captureSurface: 'cli',
      affirmativeEnable: true,
    });
  } catch (error) {
    await client
      .revokeConsent(
        project.projectId,
        consent.consentRecordId,
        credentials.accessToken,
      )
      .catch(() => undefined);
    throw error;
  }

  const coordinator = createCoordinator(dependencies, runtime);
  await coordinator.start();
  await coordinator.stop();
  const record = await runtime.installations.get(identified.projectIdentity);
  dependencies.io.out(
    record?.baselineState === 'complete'
      ? `Enabled ${displayName}. Existing conversations were skipped; new turns will sync.`
      : `Enabled ${displayName}. The cloud is offline, so the new-capture baseline is still pending.`,
  );
  dependencies.io.out('Run `baton daemon` for continuous capture.');
}

async function status(
  dependencies: CliDependencies,
  localPath: string,
): Promise<void> {
  await requireCredentials(dependencies);
  const runtime = await syncRuntime(dependencies);
  const records = await runtime.installations.list();
  if (records.length === 0) {
    dependencies.io.out('No projects are enabled. Run `baton enable`.');
    return;
  }
  const coordinator = createCoordinator(dependencies, runtime);
  await coordinator.start();
  const identified = await runtime.installations
    .identify(localPath)
    .catch(() => null);
  const statuses = coordinator
    .listStatus()
    .filter(
      (entry) =>
        identified === null ||
        entry.projectIdentity === identified.projectIdentity,
    );
  await coordinator.stop();
  if (statuses.length === 0) {
    dependencies.io.out('This project is not enabled. Run `baton enable`.');
    return;
  }
  for (const entry of statuses) {
    dependencies.io.out(`${entry.displayName}: ${entry.state}`);
    dependencies.io.out(`  ${entry.summary}`);
    if (entry.nextAction !== null) dependencies.io.out(`  ${entry.nextAction}`);
  }
}

async function pause(
  dependencies: CliDependencies,
  localPath: string,
): Promise<void> {
  const { runtime, identity } = await installationAt(dependencies, localPath);
  const record = await runtime.installations.pause(identity);
  dependencies.io.out(
    `Paused ${record.displayName}. No conversation content is read or uploaded while paused.`,
  );
}

async function resume(
  dependencies: CliDependencies,
  localPath: string,
): Promise<void> {
  await requireCredentials(dependencies);
  const { runtime, identity } = await installationAt(dependencies, localPath);
  const record = await runtime.installations.resume(identity);
  const coordinator = createCoordinator(dependencies, runtime);
  await coordinator.start();
  await coordinator.stop();
  dependencies.io.out(
    `Resumed ${record.displayName}. Content created while paused was skipped.`,
  );
}

async function disable(
  dependencies: CliDependencies,
  localPath: string,
): Promise<void> {
  const { runtime, identity, record } = await installationAt(
    dependencies,
    localPath,
  );
  if (record.state !== 'disabled')
    await runtime.installations.disable(identity);
  try {
    const credentials = await freshCredentials(
      dependencies,
      await requireCredentials(dependencies),
    );
    await createClient(dependencies, credentials.apiBaseUrl).revokeConsent(
      record.cloudProjectId,
      record.consent.consentRecordId,
      credentials.accessToken,
    );
  } catch (error) {
    throw new Error(
      `Capture is disabled locally, but cloud consent revocation still needs an internet connection. Run \`baton disable\` again. ${humanError(error)}`,
    );
  }
  dependencies.io.out(
    `Disabled ${record.displayName} and revoked this installation's collection consent. Existing cloud data was not deleted.`,
  );
}

async function daemon(dependencies: CliDependencies): Promise<void> {
  await requireCredentials(dependencies);
  const runtime = await syncRuntime(dependencies);
  const coordinator = createCoordinator(dependencies, runtime, true);
  await coordinator.start();
  dependencies.io.out(
    'Baton is watching enabled projects. Press Ctrl-C to stop.',
  );
  for (const entry of coordinator.listStatus()) {
    dependencies.io.out(`${entry.displayName}: ${entry.state}`);
  }
  await (dependencies.waitForShutdown?.() ?? waitForShutdown());
  await coordinator.stop();
  dependencies.io.out('Baton capture stopped.');
}

async function continueThread(
  dependencies: CliDependencies,
  args: string[],
): Promise<void> {
  const localPath = optionalPath(args, dependencies);
  const { record } = await installationAt(dependencies, localPath);
  const credentials = await freshCredentials(
    dependencies,
    await requireCredentials(dependencies),
  );
  const client = createClient(dependencies, credentials.apiBaseUrl);
  const now = (dependencies.now ?? Date.now)();

  const threads = await client.workThreads(
    record.cloudProjectId,
    credentials.accessToken,
  );
  const explicit = optionValue(args, '--thread');
  if (explicit !== undefined) {
    const chosen = threads.find((thread) => thread.workThreadId === explicit);
    if (chosen === undefined) {
      throw new Error('That work thread is not part of this project.');
    }
    await printThreadBootstrap(
      dependencies,
      client,
      credentials.accessToken,
      chosen,
    );
    return;
  }

  if (threads.length === 0) {
    dependencies.io.out(
      `No work threads yet for ${record.displayName}. Start working in any supported agent and Baton will capture one.`,
    );
    return;
  }

  const suggestions = (
    await client.suggestThreads(
      record.cloudProjectId,
      null,
      credentials.accessToken,
    )
  ).suggestions;
  const ranked = rankThreadsForContinue(threads, suggestions);
  dependencies.io.out(`Continue work in ${record.displayName}?`);
  ranked.slice(0, 5).forEach((thread, index) => {
    const marker = index === 0 ? '  [recommended]' : '';
    dependencies.io.out(
      `  ${index + 1}. ${thread.title} — updated ${formatRelative(thread.updatedAt, now)}${marker}`,
    );
  });
  dependencies.io.out('');
  dependencies.io.out(
    `Load one with \`baton continue --thread ${ranked[0]!.workThreadId}\`, or start a fresh session.`,
  );
}

async function printThreadBootstrap(
  dependencies: CliDependencies,
  client: BatonCloudClient,
  accessToken: string,
  thread: {
    workThreadId: string;
    title: string;
    goal: string | null;
    state: string;
  },
): Promise<void> {
  const overview = await client.workThreadOverview(
    thread.workThreadId,
    accessToken,
  );
  dependencies.io.out(`Work thread: ${thread.title} (${thread.state})`);
  dependencies.io.out(`Goal: ${thread.goal ?? '—'}`);
  dependencies.io.out(
    `Sources: ${
      overview.sessions
        .map((session) => session.sourceSession.sourceAgent)
        .join(', ') || 'none yet'
    }`,
  );
  const decisions = overview.decisions.slice(-3);
  if (decisions.length > 0) {
    dependencies.io.out('Recent decisions:');
    for (const decision of decisions)
      dependencies.io.out(`  - ${decision.summary}`);
  }
  const openTasks = overview.tasks.filter(
    (task) => task.status !== 'completed',
  );
  if (openTasks.length > 0) {
    dependencies.io.out('Open tasks:');
    for (const task of openTasks.slice(0, 5))
      dependencies.io.out(`  - ${task.text}`);
  }
  if (overview.fileActivities.length > 0) {
    dependencies.io.out(`Changed files: ${overview.fileActivities.length}`);
  }
  dependencies.io.out('');
  dependencies.io.out(
    `Baton bootstrap ready. For cited, on-demand context in a fresh agent, run \`baton mcp\` and call baton_get_thread_context with work thread ${thread.workThreadId}.`,
  );
}

async function mcpServe(dependencies: CliDependencies): Promise<void> {
  const credentials = await freshCredentials(
    dependencies,
    await requireCredentials(dependencies),
  );
  const client = createClient(dependencies, credentials.apiBaseUrl);
  const server = createBatonMcpServer(client, credentials.accessToken);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP transport; status goes to stderr only.
  dependencies.io.error(
    'Baton MCP server ready on stdio (read-only tools). Press Ctrl-C to stop.',
  );
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    const finish = () => resolve();
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
  await server.close();
}

function mcpInstall(dependencies: CliDependencies, agent?: string): void {
  const config = {
    mcpServers: {
      baton: { command: 'baton', args: ['mcp'] },
    },
  };
  dependencies.io.out(
    'Baton runs as a read-only MCP server over stdio using your logged-in credentials.',
  );
  dependencies.io.out(
    'It exposes cited work-thread context tools; it never writes or ingests.',
  );
  dependencies.io.out('');
  dependencies.io.out(
    `Add this to your ${agent ?? 'agent'} MCP configuration:`,
  );
  dependencies.io.out(JSON.stringify(config, null, 2));
  dependencies.io.out('');
  dependencies.io.out(
    'Then ask the agent to call baton_get_thread_context to resume a work thread.',
  );
}

function rankThreadsForContinue<
  T extends { workThreadId: string; updatedAt: string },
>(
  threads: T[],
  suggestions: { workThread: { workThreadId: string }; score: number }[],
): T[] {
  const score = new Map(
    suggestions.map((suggestion) => [
      suggestion.workThread.workThreadId,
      suggestion.score,
    ]),
  );
  return [...threads].sort((left, right) => {
    const scoreDelta =
      (score.get(right.workThreadId) ?? 0) -
      (score.get(left.workThreadId) ?? 0);
    if (scoreDelta !== 0) return scoreDelta;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

function formatRelative(iso: string, now: number): string {
  const deltaMs = now - Date.parse(iso);
  if (Number.isNaN(deltaMs)) return 'recently';
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

async function syncRuntime(
  dependencies: CliDependencies,
): Promise<CliSyncRuntime> {
  return (
    dependencies.syncRuntime ??
    createNativeSyncRuntime(dependencies.nativeSourceOptions)
  );
}

function createCoordinator(
  dependencies: CliDependencies,
  runtime: CliSyncRuntime,
  continuous = false,
): SyncCoordinator {
  const uploader: CloudUploader = {
    upload: async (prepared) => {
      if (prepared.contentEncoding !== 'gzip') {
        throw new UploadFailure({
          code: 'unsupported_encoding',
          message: `unsupported upload encoding: ${prepared.contentEncoding}`,
          retryable: false,
        });
      }
      const credentials = await freshCredentials(
        dependencies,
        await requireCredentials(dependencies),
      );
      try {
        return await createClient(
          dependencies,
          credentials.apiBaseUrl,
        ).uploadPrepared(
          {
            batchId: prepared.batchId,
            idempotencyKey: prepared.idempotencyKey,
            contentEncoding: 'gzip',
            body: prepared.body,
          },
          credentials.accessToken,
        );
      } catch (error) {
        throw uploadFailure(error);
      }
    },
  };
  return new SyncCoordinator({
    installations: runtime.installations,
    eventSources: runtime.eventSources,
    uploader,
    connectivity: {
      isOnline: async () => {
        const credentials = await dependencies.store.load();
        if (credentials === null) return false;
        return createClient(dependencies, credentials.apiBaseUrl)
          .health()
          .catch(() => false);
      },
    },
    ...(runtime.watcher === undefined ? {} : { watcher: runtime.watcher }),
    ...(continuous
      ? { scheduler: new IntervalReconciliationScheduler(5 * 60_000) }
      : {}),
    maxCompressedBatchBytes: 256 * 1024,
  });
}

function uploadFailure(error: unknown): UploadFailure {
  if (error instanceof UploadFailure) return error;
  if (error instanceof CloudApiError) {
    const status = error.problem.status;
    const retryable = status === 408 || status === 429 || status >= 500;
    return new UploadFailure({
      code: error.problem.code,
      message: error.problem.detail ?? error.problem.title,
      retryable,
      ...(error.problem.retryAfterSeconds === undefined
        ? {}
        : { retryAfterMs: error.problem.retryAfterSeconds * 1_000 }),
    });
  }
  return new UploadFailure({
    code: 'network_error',
    message: error instanceof Error ? error.message : 'cloud upload failed',
    retryable: true,
  });
}

async function installationAt(
  dependencies: CliDependencies,
  localPath: string,
): Promise<{
  runtime: CliSyncRuntime;
  identity: ProjectIdentity;
  record: NonNullable<Awaited<ReturnType<InstallationMap['get']>>>;
}> {
  const runtime = await syncRuntime(dependencies);
  const { projectIdentity } = await runtime.installations.identify(localPath);
  const record = await runtime.installations.get(projectIdentity);
  if (record === null) {
    throw new Error('This project is not enabled. Run `baton enable`.');
  }
  return { runtime, identity: projectIdentity, record };
}

async function existingProject(
  client: BatonCloudClient,
  projectId: string,
  accessToken: string,
) {
  const project = (await client.projects(accessToken)).find(
    (candidate) => candidate.projectId === projectId,
  );
  if (project === undefined) {
    throw new Error(
      'The previously linked cloud project no longer exists. Remove the local Baton state only after verifying cloud deletion.',
    );
  }
  if (project.state === 'enabled') return project;
  return client.updateProject(
    project.projectId,
    { state: 'enabled' },
    accessToken,
  );
}

function printCollectionDisclosure(
  io: CliIo,
  projectName: string,
  agents: AgentName[],
): void {
  io.out(COLLECTION_DISCLOSURE.replace('{project_name}', projectName));
  io.out('');
  io.out(`Detected agents: ${agents.join(', ')}`);
  io.out(
    `Collected categories: ${DEFAULT_COLLECTION_POLICY.allowedCategories.join(', ')}`,
  );
  io.out(
    `Excluded paths: ${DEFAULT_COLLECTION_POLICY.excludedPathPatterns.join(', ')}`,
  );
  io.out(
    `Payload caps: tool results ${DEFAULT_COLLECTION_POLICY.maxToolResultBytes} bytes; diffs ${DEFAULT_COLLECTION_POLICY.maxDiffBytes} bytes.`,
  );
  io.out(`Policy: ${DEFAULT_COLLECTION_POLICY.policyVersion}`);
  io.out(`Disclosure: ${COLLECTION_DISCLOSURE_VERSION}`);
}

async function reportLegacyConfiguration(
  dependencies: CliDependencies,
): Promise<void> {
  const finding = await detectLegacyGitConfiguration();
  if (!finding.found) return;
  dependencies.io.out(
    `Legacy Git configuration detected at ${finding.configPath ?? 'the prior Baton config path'}.`,
  );
  for (const line of finding.guidance) dependencies.io.out(`  ${line}`);
}

const valueFlags = new Set(['--name', '--thread', '--device-name']);

function optionalPath(args: string[], dependencies: CliDependencies): string {
  for (let index = 1; index < args.length; index += 1) {
    const value = args[index]!;
    if (valueFlags.has(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith('-')) return resolve(value);
  }
  return resolve((dependencies.cwd ?? process.cwd)());
}

async function waitForShutdown(): Promise<void> {
  await new Promise<void>((resolveShutdown) => {
    const finish = () => resolveShutdown();
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

async function requireCredentials(
  dependencies: CliDependencies,
): Promise<StoredCredentials> {
  const credentials = await dependencies.store.load();
  if (credentials === null)
    throw new Error('Not logged in. Run `baton login`.');
  return credentials;
}

async function freshCredentials(
  dependencies: CliDependencies,
  credentials: StoredCredentials,
): Promise<StoredCredentials> {
  const now = (dependencies.now ?? Date.now)();
  if (credentials.expiresAt > now + 30_000) return credentials;
  const tokens = await createClient(
    dependencies,
    credentials.apiBaseUrl,
  ).exchangeToken({
    grantType: 'refresh_token',
    clientId: 'baton-cli',
    refreshToken: credentials.refreshToken,
  });
  const refreshed: StoredCredentials = {
    apiBaseUrl: credentials.apiBaseUrl,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: now + tokens.expiresIn * 1000,
    userId: tokens.userId,
    tenantId: tokens.tenantId,
    deviceId: tokens.deviceId,
  };
  await dependencies.store.save(refreshed);
  return refreshed;
}

function createClient(
  dependencies: CliDependencies,
  baseUrl: string,
): BatonCloudClient {
  return (
    dependencies.createClient?.(baseUrl) ?? new BatonCloudClient({ baseUrl })
  );
}

function printHelp(io: CliIo): void {
  io.out('Baton Cloud CLI');
  io.out('  baton login [--device-name NAME]');
  io.out('  baton enable [PATH] [--name NAME] [--yes]');
  io.out('  baton status [PATH]');
  io.out('  baton pause [PATH]');
  io.out('  baton resume [PATH]');
  io.out('  baton disable [PATH]');
  io.out('  baton daemon');
  io.out('  baton continue [PATH] [--thread ID]');
  io.out('  baton mcp                 (read-only MCP server over stdio)');
  io.out('  baton mcp install [AGENT] (print MCP configuration)');
  io.out('  baton whoami');
  io.out('  baton logout');
  io.out('  baton doctor');
}

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('-'))
    throw new Error(`${option} requires a value.`);
  return value;
}

function defaultDeviceName(): string {
  return `${platform()} development machine`;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function humanError(error: unknown): string {
  if (error instanceof CloudApiError) {
    return `${error.problem.title}: ${error.problem.detail ?? 'The cloud request failed.'} (${error.problem.requestId})`;
  }
  return error instanceof Error
    ? error.message
    : 'An unexpected error occurred.';
}
