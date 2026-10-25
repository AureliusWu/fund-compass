/** Explicit physical-v5 -> v6 only. Versionchange intent and strict current
 * initialization are separate commits; only the original recovery-2 file can
 * reconcile that gap. Ordinary startup never constructs or repairs this store.
 */
import { isOwnerSyncOutboxDatabase, OWNER_SYNC_OUTBOX_DB_PREFIX, ownerSyncOutboxStorage } from './ownerSyncOutbox'
import { assertGuard, canonical, closed, code, CURRENT, digest, fail, FULL_SYNC, HASH, localId,
  METADATA, OwnerWorkspaceError, PORTFOLIO, RECEIPTS, STORES, SYNC, WORKING } from './owner-workspace-shared'
import { restoreOwnerPortfolioRecoveryBackup } from '@/utils/owner-portfolio-recovery'
import { canonicalOwnerLocal, OWNER_WORKSPACE_BACKUP_MAX_BYTES } from '@/utils/owner-workspace-backup'
import { validateOwnerPortfolioLocal } from '@/utils/ownerPortfolioLocal'
import { emptyOwnerPortfolioSyncMetadata, validateOwnerPortfolioSyncMetadata,
  type OwnerPortfolioSyncMetadata } from '@/utils/owner-portfolio-sync'
import { validateOwnerPortfolioSyncUpgradeIntent, verifyOwnerPortfolioSyncUpgradeIntent,
  type OwnerPortfolioSyncUpgradeIntent } from '@/utils/owner-portfolio-sync-intent'
import type { CloudUpgradeHost, OwnerWorkspace, OwnerWorkspaceErrorCode, OwnerWorkspaceGuard,
  OwnerWorkspaceLocalState } from './owner-workspace-types'

const OLD_STORES = [...STORES, SYNC, PORTFOLIO]
const ALL_STORES = [...OLD_STORES, FULL_SYNC]
const INTENT = 'intent'
const encoder = new TextEncoder()
export interface OwnerWorkspaceFullSyncUpgradeRequest {
  readonly id: string
  readonly hash: string
  readonly backupRaw: string
  readonly backupSha256: string
}
interface CompiledUpgrade {
  readonly request: OwnerWorkspaceFullSyncUpgradeRequest
  readonly expected: OwnerWorkspaceLocalState
  readonly initial: OwnerPortfolioSyncMetadata
  readonly intent: OwnerPortfolioSyncUpgradeIntent
}
function bounded(raw: unknown): string {
  if (typeof raw !== 'string') fail('workspace_invalid_input')
  if (raw.length > OWNER_WORKSPACE_BACKUP_MAX_BYTES || encoder.encode(raw).byteLength > OWNER_WORKSPACE_BACKUP_MAX_BYTES) fail('workspace_capacity')
  for (let index = 0; index < raw.length; index++) {
    const unit = raw.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = raw.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('workspace_invalid_input')
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail('workspace_invalid_input')
  }
  return raw
}
async function compile(target: string, input: Omit<OwnerWorkspaceFullSyncUpgradeRequest, 'hash'>): Promise<CompiledUpgrade> {
  if (!closed(input, ['id', 'backupRaw', 'backupSha256'])) fail('workspace_invalid_input')
  localId(target, input.id)
  const id = input.id, raw = bounded(input.backupRaw), backupSha256 = input.backupSha256
  if (typeof backupSha256 !== 'string' || !HASH.test(backupSha256)) fail('workspace_invalid_input')
  let backup: Awaited<ReturnType<typeof restoreOwnerPortfolioRecoveryBackup>>
  try { backup = await restoreOwnerPortfolioRecoveryBackup(raw, backupSha256) }
  catch (error) {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
    return fail(descriptor && 'value' in descriptor && descriptor.value === 'capacity_exceeded' ? 'workspace_capacity' : 'workspace_invalid_input')
  }
  if (backup.targetFingerprint !== target || backup.physicalVersion !== 5) fail('workspace_invalid_input')
  const expected = backup.local
  if (!expected.metadata.adoption || !expected.sync || !expected.portfolio || !expected.portfolioUpgrade
    || expected.fullSync || expected.fullSyncUpgrade || expected.receiptCount !== 0
    || expected.outbox.entry !== null || expected.sync.pending !== null) fail('workspace_pending')
  if (id === expected.metadata.adoption.id) fail('workspace_idempotency_conflict')
  const hash = await digest(canonicalOwnerLocal({ operation: 'portfolio-sync-upgrade-1', target, id, backupSha256 }))
  const request = Object.freeze({ id, hash, backupRaw: raw, backupSha256 })
  const initial = emptyOwnerPortfolioSyncMetadata(target)
  const intent = await verifyOwnerPortfolioSyncUpgradeIntent({ schema: 'owner-portfolio-sync-upgrade-1',
    targetFingerprint: target, id, hash, backupSha256 }, target)
  // Fixed real core verification also applies the complete recovery-3 24-MiB
  // capacity before versionchange can commit. No injection or field omission.
  const { validateOwnerWorkspaceLocalState } = await import('./owner-workspace')
  await validateOwnerWorkspaceLocalState(target, { ...expected, fullSync: initial, fullSyncUpgrade: intent })
  return Object.freeze({ request, expected, initial, intent })
}
export async function buildOwnerWorkspaceFullSyncUpgradeRequest(target: string,
  input: Omit<OwnerWorkspaceFullSyncUpgradeRequest, 'hash'>): Promise<OwnerWorkspaceFullSyncUpgradeRequest> {
  return (await compile(target, input)).request
}
async function checkRequest(target: string, input: OwnerWorkspaceFullSyncUpgradeRequest): Promise<CompiledUpgrade> {
  if (!closed(input, ['id', 'hash', 'backupRaw', 'backupSha256'])) fail('workspace_invalid_input')
  const expectedHash = input.hash
  const compiled = await compile(target, { id: input.id, backupRaw: input.backupRaw, backupSha256: input.backupSha256 })
  if (expectedHash !== compiled.request.hash) fail('workspace_invalid_input')
  return compiled
}
function checkedPortfolioRow(target: string, input: unknown) {
  if (!closed(input, ['schema', 'targetFingerprint', 'portfolio']) || input.schema !== 'owner-workspace-portfolio-1'
    || input.targetFingerprint !== target) fail('workspace_invalid_database')
  return validateOwnerPortfolioLocal(input.portfolio)
}
/** Re-read all SIX original stores in the actual write transaction, including
 * both portfolio rows and exact counts. Host.localState supplies real codecs. */
function readExpected(host: CloudUpgradeHost, tx: IDBTransaction, expected: OwnerWorkspaceLocalState,
  guard: OwnerWorkspaceGuard, accept: () => void, reject: (problem: OwnerWorkspaceErrorCode) => void): void {
  try {
    assertGuard(guard)
    for (const name of OLD_STORES) {
      const store = tx.objectStore(name)
      if (store.keyPath !== null || store.autoIncrement || store.indexNames.length) fail('workspace_invalid_database')
    }
    const reads = [tx.objectStore('slot').get(CURRENT), tx.objectStore('slot').count(),
      tx.objectStore(WORKING).get(CURRENT), tx.objectStore(WORKING).count(),
      tx.objectStore(METADATA).get(CURRENT), tx.objectStore(METADATA).count(), tx.objectStore(RECEIPTS).count(),
      tx.objectStore(SYNC).get(CURRENT), tx.objectStore(SYNC).count(),
      tx.objectStore(PORTFOLIO).get(CURRENT), tx.objectStore(PORTFOLIO).get(INTENT), tx.objectStore(PORTFOLIO).count()]
    let remaining = reads.length
    for (const read of reads) read.onsuccess = () => {
      if (--remaining) return
      try {
        assertGuard(guard)
        if (reads[1].result !== 1 || reads[3].result !== 1 || reads[5].result !== 1 || reads[6].result !== 0
          || reads[8].result !== 1 || reads[11].result !== 2) fail('workspace_invalid_database')
        const snapshot = host.working(reads[2].result, host.target).snapshot
        const row = ownerSyncOutboxStorage.rowShape(reads[0].result, host.target)
        const local = host.localState({ snapshot, metadata: host.checkedMetadata(reads[4].result, snapshot),
          outbox: { version: row.version, entry: row.entry }, receiptCount: reads[6].result, sync: reads[7].result,
          portfolio: checkedPortfolioRow(host.target, reads[9].result), portfolioUpgrade: reads[10].result }, host.target)
        if (canonical(local) !== canonical(expected)) fail('workspace_conflict')
        accept()
      } catch (error) { reject(code(error)) }
    }
  } catch (error) { reject(code(error)) }
}
function exactStores(db: IDBDatabase, names: readonly string[]): boolean {
  return db.objectStoreNames.length === names.length && names.every(name => db.objectStoreNames.contains(name))
}
function initialize(host: CloudUpgradeHost, factory: IDBFactory, compiled: CompiledUpgrade,
  guard: OwnerWorkspaceGuard, signal: AbortSignal, abortCode: () => OwnerWorkspaceErrorCode,
  upgrading: boolean): Promise<OwnerWorkspace> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | undefined, tx: IDBTransaction | undefined, handle: OwnerWorkspace | undefined, settled = false
    const finish = (problem?: OwnerWorkspaceErrorCode) => {
      if (settled) return
      if (!problem) { try { assertGuard(guard) } catch (error) { problem = code(error) } }
      settled = true; signal.removeEventListener('abort', abort)
      if (problem) {
        try { tx?.abort() } catch { /* Versionchange may already have committed. */ }
        handle?.close(); db?.close(); reject(new OwnerWorkspaceError(problem))
      } else resolve(handle!)
    }
    const abort = () => finish(abortCode())
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try {
      assertGuard(guard)
      const request = upgrading ? factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + host.target, 6)
        : factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + host.target)
      request.onblocked = () => finish('workspace_blocked')
      request.onerror = () => finish('workspace_invalid_database')
      request.onupgradeneeded = event => {
        db = request.result; tx = request.transaction!
        if (settled || !upgrading || event.oldVersion !== 5 || !exactStores(db, OLD_STORES)) {
          try { tx.abort() } catch { /* Missing/old databases are never created or repaired. */ }
          finish('workspace_invalid_database'); return
        }
        readExpected(host, tx, compiled.expected, guard, () => {
          if (settled) return
          assertGuard(guard)
          db!.createObjectStore(FULL_SYNC).add(compiled.intent, INTENT)
        }, finish)
      }
      request.onsuccess = () => {
        db = request.result
        if (settled) { db.close(); return }
        db.onversionchange = () => finish('workspace_closed')
        db.onclose = () => finish('workspace_closed')
        try {
          assertGuard(guard)
          if (db.version !== 6 || !exactStores(db, ALL_STORES) || !isOwnerSyncOutboxDatabase(db)) fail('workspace_invalid_database')
          tx = db.transaction(ALL_STORES, 'readwrite', { durability: 'strict' })
          if (tx.durability !== 'strict') fail('workspace_unavailable')
          const store = tx.objectStore(FULL_SYNC)
          if (store.keyPath !== null || store.autoIncrement || store.indexNames.length) fail('workspace_invalid_database')
          const reads = [store.get(CURRENT), store.get(INTENT), store.count()]
          let remaining = reads.length
          for (const read of reads) read.onsuccess = () => {
            if (--remaining || settled) return
            readExpected(host, tx!, compiled.expected, guard, () => {
              if (settled) return
              const intent = validateOwnerPortfolioSyncUpgradeIntent(reads[1].result, host.target)
              if (canonical(intent) !== canonical(compiled.intent)) fail('workspace_idempotency_conflict')
              if (reads[2].result === 1 && reads[0].result === undefined) {
                assertGuard(guard); store.add(compiled.initial, CURRENT)
              } else if (!upgrading && reads[2].result === 2 && reads[0].result !== undefined) {
                const current = validateOwnerPortfolioSyncMetadata(reads[0].result, host.target,
                  { snapshot: compiled.expected.snapshot, metadata: compiled.expected.metadata, outbox: compiled.expected.outbox })
                if (canonical(current) !== canonical(compiled.initial)) fail('workspace_conflict')
              } else fail('workspace_invalid_database')
            }, finish)
          }
          tx.onerror = () => finish(code(tx?.error, 'workspace_aborted'))
          tx.onabort = () => finish(code(tx?.error, 'workspace_aborted'))
          tx.oncomplete = () => {
            if (settled) { db?.close(); return }
            try {
              assertGuard(guard)
              handle = host.makeWorkspace(db!, host.target)
              handle.readLocalState(guard).then(state => {
                if (canonical(state) !== canonical({ ...compiled.expected, fullSync: compiled.initial, fullSyncUpgrade: compiled.intent })) finish('workspace_conflict')
                else finish()
              }, error => finish(code(error)))
            } catch (error) { finish(code(error)) }
          }
        } catch (error) { finish(code(error)) }
      }
    } catch (error) { finish(code(error)) }
  })
}
export async function upgradeOwnerWorkspaceFullSync(host: CloudUpgradeHost, factory: IDBFactory,
  input: OwnerWorkspaceFullSyncUpgradeRequest, guard: OwnerWorkspaceGuard, signal: AbortSignal,
  abortCode: () => OwnerWorkspaceErrorCode): Promise<OwnerWorkspace> {
  assertGuard(guard)
  const compiled = await checkRequest(host.target, input)
  assertGuard(guard)
  const existing = await host.openExistingWorkspace(factory, host.target, signal)
  try {
    if (canonical(await existing.readLocalState(guard)) !== canonical(compiled.expected)) fail('workspace_conflict')
  } finally { existing.close() }
  const version = await host.strictProbe(factory, host.target,
    { ...compiled.expected.outbox, resourceFingerprint: host.target }, signal)
  if (version !== 5) fail('workspace_invalid_database')
  assertGuard(guard)
  return initialize(host, factory, compiled, guard, signal, abortCode, true)
}
/** Opens without a version: only existing v6 with original six-store preimage,
 * matching intent and absent/exact initial current qualifies. No disaster restore.
 */
export async function reconcileOwnerWorkspaceFullSyncUpgrade(host: CloudUpgradeHost, factory: IDBFactory,
  input: OwnerWorkspaceFullSyncUpgradeRequest, guard: OwnerWorkspaceGuard, signal: AbortSignal,
  abortCode: () => OwnerWorkspaceErrorCode): Promise<OwnerWorkspace> {
  assertGuard(guard)
  const compiled = await checkRequest(host.target, input)
  assertGuard(guard)
  return initialize(host, factory, compiled, guard, signal, abortCode, false)
}
