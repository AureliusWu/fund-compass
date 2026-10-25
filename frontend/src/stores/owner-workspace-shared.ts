/** Small shared primitives only; no sync metadata/planner or IDB creation. */
import { OwnerCloudImportError } from '@/utils/owner-cloud-import'
import { OwnerWorkspaceBackupError } from '@/utils/owner-workspace-backup'
import { OwnerSyncOutboxError } from './ownerSyncOutbox'
import { OwnerWorkspaceSyncError, OwnerWorkspaceSyncMetadataError } from '@/utils/owner-workspace-sync-errors'
import type { OwnerWorkspaceErrorCode, OwnerWorkspaceGuard } from './owner-workspace-types'
export const WORKING = 'working_copy', RECEIPTS = 'import_receipts', METADATA = 'local_metadata', CURRENT = 'current'
export const STORES = ['slot', WORKING, RECEIPTS, METADATA]
export const SYNC = 'sync_metadata'
export const PORTFOLIO = 'portfolio_metadata'
export const SCHEMA = 'owner-workspace-1'
export const RECEIPT_SCHEMA = 'owner-workspace-receipt-1'
export const HASH = /^[0-9a-f]{64}(?![\s\S])/
export const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}(?![\s\S])/
export const MAX_RECEIPTS = 200

export class OwnerWorkspaceError extends Error {
  constructor(readonly code: OwnerWorkspaceErrorCode) {
    super('Owner workspace operation rejected')
    this.name = 'OwnerWorkspaceError'
  }
}
export function fail(code: OwnerWorkspaceErrorCode): never { throw new OwnerWorkspaceError(code) }
export function code(error: unknown, fallback: OwnerWorkspaceErrorCode = 'workspace_unavailable'): OwnerWorkspaceErrorCode {
  if (error instanceof OwnerWorkspaceError) return error.code
  if (error instanceof OwnerCloudImportError) return error.code === 'capacity_exceeded' ? 'workspace_capacity' : 'workspace_invalid_input'
  if (error instanceof OwnerWorkspaceBackupError) return error.code === 'capacity_exceeded' ? 'workspace_capacity' : 'workspace_invalid_input'
  if (error instanceof OwnerWorkspaceSyncMetadataError) return error.code === 'capacity_exceeded' ? 'workspace_capacity' : 'workspace_invalid_input'
  if (error instanceof OwnerWorkspaceSyncError) return error.code === 'capacity_exceeded' ? 'workspace_capacity' : 'workspace_invalid_input'
  if (error instanceof OwnerSyncOutboxError) return error.code === 'outbox_blocked' ? 'workspace_blocked'
    : error.code === 'outbox_invalid_target' ? 'workspace_invalid_target' : 'workspace_invalid_database'
  try { if ((error as { name?: string } | null)?.name === 'QuotaExceededError') return 'workspace_quota' } catch { /* fixed code */ }
  return fallback
}
export function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(descriptors, key))
    && Object.values(descriptors).every(item => item.enumerable && 'value' in item)
}
export function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail('workspace_invalid_input')
  return value
}
export function increment(value: number): number {
  if (value === Number.MAX_SAFE_INTEGER) fail('workspace_version_exhausted')
  return value + 1
}
export function canonical(value: unknown): string {
  if (typeof value === 'number' && Object.is(value, -0)) return '-0'
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

export async function digest(raw: string): Promise<string> {
  try {
    const result = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
    return [...new Uint8Array(result)].map(item => item.toString(16).padStart(2, '0')).join('')
  } catch { fail('workspace_unavailable') }
}

export function assertGuard(guard: OwnerWorkspaceGuard): void {
  try {
    if (!guard || !guard.signal || typeof guard.signal.aborted !== 'boolean' || guard.signal.aborted
        || typeof guard.signal.addEventListener !== 'function' || typeof guard.signal.removeEventListener !== 'function'
        || typeof guard.assertActive !== 'function') fail('workspace_context_changed')
    guard.assertActive()
    if (guard.signal.aborted) fail('workspace_context_changed')
  } catch { fail('workspace_context_changed') }
}

export function localId(target: string, id: string): void {
  if (typeof target !== 'string' || !HASH.test(target)) fail('workspace_invalid_target')
  if (typeof id !== 'string' || !ID.test(id)) fail('workspace_invalid_input')
}
