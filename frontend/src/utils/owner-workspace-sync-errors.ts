/** Fixed, shared error identity only; no planner, metadata, storage or IO. */
export class OwnerWorkspaceSyncError extends Error {
  readonly code: 'invalid_baseline' | 'invalid_workspace' | 'capacity_exceeded'
  constructor(code: 'invalid_baseline' | 'invalid_workspace' | 'capacity_exceeded') {
    super('Owner workspace sync input rejected')
    this.name = 'OwnerWorkspaceSyncError'
    this.code = ['invalid_baseline', 'invalid_workspace', 'capacity_exceeded'].includes(code) ? code : 'invalid_workspace'
  }
}

export class OwnerWorkspaceSyncMetadataError extends Error {
  constructor(readonly code: 'invalid_metadata' | 'capacity_exceeded' = 'invalid_metadata') {
    super('Owner workspace sync metadata rejected')
    this.name = 'OwnerWorkspaceSyncMetadataError'
  }
}
