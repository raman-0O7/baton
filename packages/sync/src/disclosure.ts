import { createHash } from 'node:crypto';

import {
  CollectionPolicySchema,
  currentCollectionDisclosureDigest,
  currentCollectionDisclosureVersion,
  type CollectionPolicy,
} from '@baton/protocol';

export const COLLECTION_POLICY_VERSION = 'hosted-default-v1' as const;
export const COLLECTION_DISCLOSURE_VERSION = currentCollectionDisclosureVersion;

/**
 * Frozen, user-visible Phase 0 disclosure. Changing these bytes changes the
 * digest and requires a new disclosure version rather than an in-place edit.
 */
export const COLLECTION_DISCLOSURE = `Enable Baton Cloud for {project_name} on this device?

Baton will continuously read supported AI-agent conversations created for this project and upload only the categories shown below. Baton Cloud can read and process this content to organize work, retrieve context, and provide features you request.

Baton-managed model providers may process the minimum excerpts needed for summaries, retrieval, and memory candidates. Baton and its providers do not use your content to train shared models. Provider copies expire within 30 days; Baton requests shorter or zero retention where available.

Before upload, Baton excludes disallowed categories, applies the displayed size limits, and redacts detected credentials on this device. Secret detection reduces risk but cannot guarantee that every sensitive value will be found.

Capture continues until you pause or disable it. Pausing or disabling stops new uploads but does not delete existing cloud data. You can inspect, export, or delete project data from Baton. Deleted content becomes unavailable from live systems within 1 hour, is removed from controlled primary and derived stores within 24 hours, and expires from encrypted backups within 35 days.

Enabling new capture does not import older conversations. Historical import has a separate preview and confirmation.`;

export const COLLECTION_DISCLOSURE_DIGEST = createHash('sha256')
  .update(COLLECTION_DISCLOSURE, 'utf8')
  .digest('hex');

if (COLLECTION_DISCLOSURE_DIGEST !== currentCollectionDisclosureDigest) {
  throw new Error(
    'frozen collection disclosure bytes do not match the server contract',
  );
}

const parsedDefaultCollectionPolicy = CollectionPolicySchema.parse({
  policyVersion: COLLECTION_POLICY_VERSION,
  allowedCategories: [
    'conversation_text',
    'plans_and_tasks',
    'command_arguments',
    'tool_results',
    'file_paths',
    'diffs',
    'session_metadata',
  ],
  excludedPathPatterns: [
    '.env',
    '.env.*',
    '**/.env',
    '**/.env.*',
    '**/*credential*',
    '**/*secret*',
    '**/*.pem',
    '**/*.key',
  ],
  maxToolResultBytes: 65_536,
  maxDiffBytes: 131_072,
});
Object.freeze(parsedDefaultCollectionPolicy.allowedCategories);
Object.freeze(parsedDefaultCollectionPolicy.excludedPathPatterns);
export const DEFAULT_COLLECTION_POLICY: Readonly<CollectionPolicy> =
  Object.freeze(parsedDefaultCollectionPolicy);

export function isPolicyWidening(
  current: CollectionPolicy,
  proposed: CollectionPolicy,
): boolean {
  const currentCategories = new Set(current.allowedCategories);
  const proposedExclusions = new Set(proposed.excludedPathPatterns);
  return (
    proposed.allowedCategories.some(
      (category) => !currentCategories.has(category),
    ) ||
    proposed.maxToolResultBytes > current.maxToolResultBytes ||
    proposed.maxDiffBytes > current.maxDiffBytes ||
    current.excludedPathPatterns.some(
      (pattern) => !proposedExclusions.has(pattern),
    )
  );
}
