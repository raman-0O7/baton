import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const serviceName = 'dev.baton.cli';
const accountName = 'cloud-credentials';

export interface StoredCredentials {
  apiBaseUrl: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
  tenantId: string;
  deviceId: string;
}

export interface CredentialStore {
  load(): Promise<StoredCredentials | null>;
  save(credentials: StoredCredentials): Promise<void>;
  clear(): Promise<void>;
  readonly description: string;
}

export class MemoryCredentialStore implements CredentialStore {
  readonly description = 'memory';
  private value: StoredCredentials | null = null;

  async load(): Promise<StoredCredentials | null> {
    return this.value === null ? null : structuredClone(this.value);
  }

  async save(credentials: StoredCredentials): Promise<void> {
    this.value = structuredClone(credentials);
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

export class FileCredentialStore implements CredentialStore {
  readonly description: string;

  constructor(private readonly path = defaultCredentialPath()) {
    this.description = `protected file (${path})`;
  }

  async load(): Promise<StoredCredentials | null> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return parseCredentials(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  async save(credentials: StoredCredentials): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.path), 0o700);
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(credentials)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) throw error;
    }
  }
}

class MacOsKeychainStore implements CredentialStore {
  readonly description = 'macOS Keychain';

  async load(): Promise<StoredCredentials | null> {
    try {
      const result = await execFile('security', [
        'find-generic-password',
        '-s',
        serviceName,
        '-a',
        accountName,
        '-w',
      ]);
      return parseCredentials(JSON.parse(result.stdout.trim()) as unknown);
    } catch (error) {
      if (isProcessExit(error)) return null;
      throw error;
    }
  }

  async save(credentials: StoredCredentials): Promise<void> {
    await execFile('security', [
      'add-generic-password',
      '-U',
      '-s',
      serviceName,
      '-a',
      accountName,
      '-w',
      JSON.stringify(credentials),
    ]);
  }

  async clear(): Promise<void> {
    try {
      await execFile('security', [
        'delete-generic-password',
        '-s',
        serviceName,
        '-a',
        accountName,
      ]);
    } catch (error) {
      if (!isProcessExit(error)) throw error;
    }
  }
}

class ResilientCredentialStore implements CredentialStore {
  readonly description: string;

  constructor(
    private readonly preferred: CredentialStore,
    private readonly fallback: CredentialStore,
  ) {
    this.description = `${preferred.description}, with ${fallback.description} fallback`;
  }

  async load(): Promise<StoredCredentials | null> {
    try {
      return (await this.preferred.load()) ?? this.fallback.load();
    } catch {
      return this.fallback.load();
    }
  }

  async save(credentials: StoredCredentials): Promise<void> {
    try {
      await this.preferred.save(credentials);
      await this.fallback.clear();
    } catch {
      await this.fallback.save(credentials);
    }
  }

  async clear(): Promise<void> {
    await Promise.allSettled([this.preferred.clear(), this.fallback.clear()]);
  }
}

export function createCredentialStore(forceFile = false): CredentialStore {
  const file = new FileCredentialStore();
  if (!forceFile && platform() === 'darwin') {
    return new ResilientCredentialStore(new MacOsKeychainStore(), file);
  }
  return file;
}

export function defaultCredentialPath(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configHome = environment.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(configHome, 'baton', 'cloud-credentials.json');
}

function parseCredentials(value: unknown): StoredCredentials {
  if (!isRecord(value))
    throw new TypeError(
      'Stored Baton credentials are malformed. Run `baton login` again.',
    );
  for (const key of [
    'apiBaseUrl',
    'accessToken',
    'refreshToken',
    'userId',
    'tenantId',
    'deviceId',
  ] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new TypeError(
        'Stored Baton credentials are malformed. Run `baton login` again.',
      );
    }
  }
  if (
    typeof value.expiresAt !== 'number' ||
    !Number.isFinite(value.expiresAt)
  ) {
    throw new TypeError(
      'Stored Baton credentials are malformed. Run `baton login` again.',
    );
  }
  return value as unknown as StoredCredentials;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrorCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code;
}

function isProcessExit(value: unknown): boolean {
  return isRecord(value) && typeof value.code === 'number';
}
