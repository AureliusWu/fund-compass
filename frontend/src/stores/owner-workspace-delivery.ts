/** Explicit managed local delivery/ACK contracts. No HTTP, session or IDB IO. */
import type { OwnerWorkspaceSyncState } from './owner-workspace'
import { ownerSyncOutboxStorage, type OwnerSyncOutboxState } from './ownerSyncOutbox'
import { restoreOwnerSyncRequest } from '@/utils/ownerSyncContract'
import { validateOwnerWorkspaceSnapshot } from '@/utils/owner-cloud-import'
import { validateOwnerWorkspaceLocalMetadata, canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { validateOwnerWorkspaceSyncMetadata } from '@/utils/owner-workspace-sync-metadata'
import { validateOwnerWorkspaceCloudBaseline } from '@/utils/owner-workspace-sync-baseline'
import { buildOwnerWorkspaceAckPreview, type OwnerWorkspaceAckPreview, type OwnerWorkspaceAckResolution,
  type OwnerWorkspaceAckRawMatched } from '@/utils/owner-workspace-ack'

export interface OwnerWorkspaceDeliveryRequest {
  readonly expected: OwnerWorkspaceSyncState
  readonly requestId: string
  readonly requestHash: string
  readonly preparationHash: string
  readonly nextState: Exclude<OwnerSyncOutboxState, 'prepared'>
}
export interface OwnerWorkspaceAckCloudInput {
  readonly id: string
  readonly expected: OwnerWorkspaceSyncState
  readonly matchedResult: OwnerWorkspaceAckRawMatched
  readonly completeBaseline: NonNullable<OwnerWorkspaceSyncState['sync']['base']>
  readonly minimumObservedRevision: number
  readonly resolutions: readonly OwnerWorkspaceAckResolution[]
}
export interface OwnerWorkspaceAckCloudRequest extends OwnerWorkspaceAckCloudInput { readonly hash: string }
export class OwnerWorkspaceDeliveryError extends Error {
  constructor(readonly code: 'invalid_delivery' | 'invalid_ack' | 'ack_unresolved' | 'hash_unavailable') {
    super('Owner workspace managed operation rejected'); this.name = 'OwnerWorkspaceDeliveryError'
  }
}
const HASH = /^[0-9a-f]{64}(?![\s\S])/, ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}(?![\s\S])/
const INPUT_KEYS = ['id', 'expected', 'matchedResult', 'completeBaseline', 'minimumObservedRevision', 'resolutions']
function fail(code: OwnerWorkspaceDeliveryError['code'] = 'invalid_ack'): never { throw new OwnerWorkspaceDeliveryError(code) }
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(descriptors, key))
    || Object.values(descriptors).some(item => !item.enumerable || !('value' in item))) fail()
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]))
}
function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) fail()
  return value
}
function id(value: unknown): string { if (typeof value !== 'string' || !ID.test(value)) fail(); return value }
function hash(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) fail(); return value }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function state(input: unknown, target: string): OwnerWorkspaceSyncState {
  const row = closed(input, ['local', 'sync']), local = closed(row.local, ['snapshot', 'outbox', 'metadata', 'receiptCount', 'sync'])
  const snapshot = validateOwnerWorkspaceSnapshot(local.snapshot), metadata = validateOwnerWorkspaceLocalMetadata(local.metadata, snapshot)
  const outbox = closed(local.outbox, ['version', 'entry'])
  if (outbox.entry !== null) closed(outbox.entry, ['schema', 'state', 'rawBody', 'requestHash'])
  const slot = ownerSyncOutboxStorage.rowShape({ ...outbox, resourceFingerprint: hash(target) }, target)
  const receiptCount = counter(local.receiptCount)
  if (receiptCount > 200) fail()
  const context = { snapshot, metadata, outbox: { version: slot.version, entry: slot.entry } }
  const sync = validateOwnerWorkspaceSyncMetadata(row.sync, target, context)
  const localSync = validateOwnerWorkspaceSyncMetadata(local.sync, target, context)
  if (canonicalOwnerLocal(sync) !== canonicalOwnerLocal(localSync)) fail()
  return freeze({ local: { ...context, receiptCount, sync }, sync })
}
function matched(input: unknown): OwnerWorkspaceAckRawMatched {
  const row = closed(input, ['source', 'requestId', 'requestHash', 'status', 'rawBody'])
  if (row.source !== 'write' && row.source !== 'receipt' || typeof row.rawBody !== 'string'
    || typeof row.status !== 'number' || !Number.isSafeInteger(row.status) || Object.is(row.status, -0)) fail()
  return freeze({ source: row.source, requestId: id(row.requestId), requestHash: hash(row.requestHash),
    status: row.status, rawBody: row.rawBody })
}
function resolutions(input: unknown): readonly OwnerWorkspaceAckResolution[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > 1400
    || Reflect.ownKeys(input).length !== input.length + 1
    || Object.keys(input).some((key, index) => key !== String(index))
    || Object.entries(Object.getOwnPropertyDescriptors(input)).some(([key, item]) => !('value' in item) || key !== 'length' && !item.enumerable)) fail()
  return freeze(input.map(value => {
    const row = closed(value, ['key', 'field', 'choice'])
    if (typeof row.key !== 'string' || row.key.length > 160
      || !['name', 'shares', 'cost', 'target_weight', 'lifecycle', 'rename'].includes(row.field as string)
      || row.choice !== 'local' && row.choice !== 'cloud') fail()
    return { key: row.key, field: row.field as OwnerWorkspaceAckResolution['field'], choice: row.choice }
  }))
}
async function digest(raw: string): Promise<string> {
  try {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
    return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  } catch { return fail('hash_unavailable') }
}
function inputShape(target: string, value: unknown): OwnerWorkspaceAckCloudInput {
  const row = closed(value, INPUT_KEYS), expected = state(row.expected, target)
  const pending = expected.sync.pending, slot = expected.local.outbox.entry
  if (!pending || !slot || !['confirmed', 'conflict'].includes(slot.state) || !expected.sync.base) fail()
  const requestId = id(row.id)
  if (requestId === pending.requestId || requestId === expected.local.metadata.adoption?.id
    || requestId === expected.local.metadata.recentEdit?.id || requestId === expected.sync.recentReceipt?.id) fail()
  const result = matched(row.matchedResult)
  if (result.requestId !== pending.requestId || result.requestHash !== pending.requestHash) fail()
  return freeze({ id: requestId, expected, matchedResult: result,
    completeBaseline: validateOwnerWorkspaceCloudBaseline(row.completeBaseline),
    minimumObservedRevision: counter(row.minimumObservedRevision), resolutions: resolutions(row.resolutions) })
}
async function compile(target: string, input: unknown): Promise<{ input: OwnerWorkspaceAckCloudInput; preview: OwnerWorkspaceAckPreview }> {
  const value = inputShape(target, input), pending = value.expected.sync.pending!
  const packet = await restoreOwnerSyncRequest(pending.rawBody, pending.requestHash)
  if (packet.request.request_id !== pending.requestId || packet.request.expected_revision !== pending.baseRevision) fail()
  const keyDigests = await Promise.all(packet.request.operations.map(async operation => ({ key: operation.key,
    digest: (await digest(operation.key)).slice(0, 16) })))
  const preview = buildOwnerWorkspaceAckPreview({ base: value.expected.sync.base, localSnapshot: value.expected.local.snapshot,
    packet, matchedResult: value.matchedResult, completeBaseline: value.completeBaseline,
    minimumObservedRevision: value.minimumObservedRevision, keyDigests, resolutions: value.resolutions })
  if (preview.issues.length || preview.outcome !== (value.expected.local.outbox.entry!.state === 'confirmed' ? 'success' : 'conflict')) fail()
  return { input: value, preview }
}

export function validateOwnerWorkspaceDeliveryRequest(target: string, input: unknown): OwnerWorkspaceDeliveryRequest {
  try {
    const row = closed(input, ['expected', 'requestId', 'requestHash', 'preparationHash', 'nextState'])
    const expected = state(row.expected, target), pending = expected.sync.pending, current = expected.local.outbox.entry
    if (!pending || !current || pending.requestId !== id(row.requestId) || pending.requestHash !== hash(row.requestHash)
      || pending.preparationHash !== hash(row.preparationHash)) fail('invalid_delivery')
    const allowed: Record<OwnerSyncOutboxState, readonly string[]> = { prepared: ['attempted'],
      attempted: ['unknown', 'confirmed', 'conflict'], unknown: ['confirmed', 'conflict'], confirmed: [], conflict: [] }
    if (typeof row.nextState !== 'string' || !allowed[current.state].includes(row.nextState)) fail('invalid_delivery')
    return freeze({ expected, requestId: pending.requestId, requestHash: pending.requestHash,
      preparationHash: pending.preparationHash, nextState: row.nextState as OwnerWorkspaceDeliveryRequest['nextState'] })
  } catch { return fail('invalid_delivery') }
}
/** Supplied-response contract only. Provenance and current-session consent stay in the coordinator/guard. */
export async function previewOwnerWorkspaceAck(target: string, input: OwnerWorkspaceAckCloudInput): Promise<OwnerWorkspaceAckPreview> {
  try { return (await compile(target, input)).preview } catch (error) {
    if (error instanceof OwnerWorkspaceDeliveryError) throw error
    return fail()
  }
}
export async function buildOwnerWorkspaceAckCloudRequest(target: string, input: OwnerWorkspaceAckCloudInput): Promise<OwnerWorkspaceAckCloudRequest> {
  try {
    return await seal(target, await compile(target, input))
  } catch (error) {
    if (error instanceof OwnerWorkspaceDeliveryError) throw error
    return fail()
  }
}
export async function rehydrateOwnerWorkspaceAckCloudRequest(target: string,
  input: OwnerWorkspaceAckCloudRequest): Promise<{ request: OwnerWorkspaceAckCloudRequest; preview: OwnerWorkspaceAckPreview }> {
  try {
    const row = closed(input, [...INPUT_KEYS, 'hash'])
    const value = Object.fromEntries(INPUT_KEYS.map(key => [key, row[key]])) as unknown as OwnerWorkspaceAckCloudInput
    const compiled = await compile(target, value), request = await seal(target, compiled)
    if (request.hash !== hash(row.hash)) fail()
    // Return the very plan included in the verified hash, not a second planner
    // result computed after another asynchronous restore/digest sequence.
    return freeze({ request, preview: compiled.preview })
  } catch (error) {
    if (error instanceof OwnerWorkspaceDeliveryError) throw error
    return fail()
  }
}
async function seal(target: string, compiled: { input: OwnerWorkspaceAckCloudInput; preview: OwnerWorkspaceAckPreview }): Promise<OwnerWorkspaceAckCloudRequest> {
  if (!compiled.preview.nextSnapshot || !compiled.preview.baseD) fail('ack_unresolved')
  // Bind the derived plan too, so a changed planner cannot silently reuse an
  // older UI's input hash for a different postimage. This is not authentication.
  return freeze({ ...compiled.input, hash: await digest(canonicalOwnerLocal({ operation: 'cloud-ack-1', target,
    input: compiled.input, preview: compiled.preview })) })
}
