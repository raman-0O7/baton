import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ReadOnlyConfigReader {
  read(path: string): Promise<string | null>;
}

const filesystemReader: ReadOnlyConfigReader = {
  read: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null;
      throw error;
    }
  },
};

export interface LegacyGitFinding {
  found: boolean;
  configPath: string | null;
  hasRepositoryPath: boolean;
  hasRemote: boolean;
  hasEncryptionSettings: boolean;
  guidance: string[];
}

/** Detection only: no TOML writes, Git commands, remote access, or migration. */
export async function detectLegacyGitConfiguration(
  options: {
    paths?: string[];
    reader?: ReadOnlyConfigReader;
    homeDirectory?: string;
    xdgConfigHome?: string;
  } = {},
): Promise<LegacyGitFinding> {
  const home = options.homeDirectory ?? homedir();
  const paths = options.paths ?? [
    join(
      options.xdgConfigHome ?? join(home, '.config'),
      'baton',
      'config.toml',
    ),
  ];
  const reader = options.reader ?? filesystemReader;

  for (const path of paths) {
    const content = await reader.read(path);
    if (content === null) continue;
    const finding = {
      found: legacySetting(content),
      configPath: path,
      hasRepositoryPath: /^\s*repo_path\s*=/m.test(content),
      hasRemote: /^\s*remote\s*=\s*['"][^'"]+['"]/m.test(content),
      hasEncryptionSettings:
        /^\s*encrypt\s*=\s*true/m.test(content) ||
        /^\s*age_recipients\s*=/m.test(content),
    };
    return {
      ...finding,
      guidance: finding.found ? legacyMigrationGuidance() : [],
    };
  }

  return {
    found: false,
    configPath: null,
    hasRepositoryPath: false,
    hasRemote: false,
    hasEncryptionSettings: false,
    guidance: [],
  };
}

export function legacyMigrationGuidance(): string[] {
  return [
    'Your legacy Git repository remains unchanged and is not used as Baton Cloud storage.',
    'Enable each hosted project separately; login or detection never grants collection consent.',
    'New capture starts from the enable-time cursor and does not import Git history or older sessions.',
    'A future `baton migrate cloud --dry-run` will preview eligible history, bytes, and redactions before separate import consent.',
    'Do not delete the legacy repository until you have independently verified any future migration or export.',
  ];
}

function legacySetting(content: string): boolean {
  return (
    /^(\s*)(repo_path|remote|device_id|encrypt|age_recipients|debounce_seconds)\s*=/m.test(
      content,
    ) || /^\s*\[push\]\s*$/m.test(content)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
