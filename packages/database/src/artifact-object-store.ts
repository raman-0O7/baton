export const allowedArtifactClasses = [
  'scrubbed_diff',
  'scrubbed_tool_result',
] as const;
export type AllowedArtifactClass = (typeof allowedArtifactClasses)[number];

export interface ArtifactObjectDescriptor {
  tenantId: string;
  projectId: string;
  sourceEventId: string;
  artifactClass: AllowedArtifactClass;
  contentHash: string;
  byteCount: number;
  mediaType: 'application/json' | 'text/plain';
}

export interface ArtifactUploadGrant {
  artifactId: string;
  opaqueObjectKey: string;
  uploadUrl: URL;
  expiresAt: string;
}

/**
 * Authorization-aware boundary for quarantined, explicitly allowed artifacts.
 * It intentionally has no method capable of accepting a native session,
 * repository snapshot, arbitrary attachment, filename, or local path.
 */
export interface ArtifactObjectStore {
  createQuarantinedUpload(
    descriptor: ArtifactObjectDescriptor,
  ): Promise<ArtifactUploadGrant>;
  finalizeQuarantinedUpload(
    descriptor: ArtifactObjectDescriptor & { artifactId: string },
  ): Promise<void>;
  deleteObject(tenantId: string, artifactId: string): Promise<void>;
}
