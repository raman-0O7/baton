import { describe, expect, it } from 'vitest';

import {
  SyncStatusTracker,
  detectLegacyGitConfiguration,
  initialStatus,
  type ProjectIdentity,
} from '../src/index.js';

const identity = `project:v1:${'a'.repeat(64)}` as ProjectIdentity;

describe('read-only legacy Git guidance', () => {
  it('detects legacy settings without exposing remote contents or writing', async () => {
    const reads: string[] = [];
    const finding = await detectLegacyGitConfiguration({
      paths: ['/config/baton/config.toml'],
      reader: {
        read: async (path) => {
          reads.push(path);
          return `repo_path = "/private/baton/repo"
remote = "git@github.com:private/secret.git"
encrypt = true
age_recipients = ["age1private"]
[push]
mode = "session-end"`;
        },
      },
    });

    expect(reads).toEqual(['/config/baton/config.toml']);
    expect(finding).toMatchObject({
      found: true,
      configPath: '/config/baton/config.toml',
      hasRepositoryPath: true,
      hasRemote: true,
      hasEncryptionSettings: true,
    });
    expect(finding.guidance.join(' ')).not.toContain('secret.git');
    expect(finding.guidance.join(' ')).toContain('remains unchanged');
    expect(finding.guidance.join(' ')).toContain('--dry-run');
  });

  it('returns no migration suggestion when no legacy config exists', async () => {
    await expect(
      detectLegacyGitConfiguration({
        paths: ['/missing'],
        reader: { read: async () => null },
      }),
    ).resolves.toEqual({
      found: false,
      configPath: null,
      hasRepositoryPath: false,
      hasRemote: false,
      hasEncryptionSettings: false,
      guidance: [],
    });
  });
});

describe('actionable sync status', () => {
  it('keeps pause visible and returns defensive copies', () => {
    const tracker = new SyncStatusTracker();
    tracker.set(
      initialStatus({
        projectIdentity: identity,
        displayName: 'Baton',
        state: 'paused',
        baselinePending: false,
      }),
    );
    const status = tracker.get(identity)!;
    expect(status).toMatchObject({
      state: 'paused',
      summary: 'Capture is paused.',
      nextAction: expect.stringContaining('baton resume'),
    });
    status.summary = 'mutated';
    expect(tracker.get(identity)?.summary).toBe('Capture is paused.');
  });
});
