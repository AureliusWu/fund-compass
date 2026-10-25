/** Explicit physical-v4 -> v5 upgrade only. The core supplies this private host;
 * callers cannot inject a codec or make ordinary startup create portfolio data.
 * Versionchange and strict initialization are separate commits. A failure never
 * implies rollback; only the original complete file can reconcile that gap.
 */
import { isOwnerSyncOutboxDatabase, OWNER_SYNC_OUTBOX_DB_PREFIX, ownerSyncOutboxStorage } from './ownerSyncOutbox'
import { assertGuard, canonical, closed, code, CURRENT, digest, fail, HASH, localId, METADATA,
  OwnerWorkspaceError, PORTFOLIO, RECEIPTS, STORES, SYNC, WORKING } from './owner-workspace-shared'
import { buildOwnerWorkspaceRecoveryBackup, validateOwnerWorkspaceRecoveryBackup,
  type OwnerWorkspaceRecoveryBackup } from '@/utils/owner-workspace-recovery'
import { canonicalOwnerLocal, OWNER_WORKSPACE_BACKUP_MAX_BYTES } from '@/utils/owner-workspace-backup'
import { parseOwnerBusinessJson } from '@/utils/owner-legacy-seed'
import { previewOwnerPortfolioMigration, validateOwnerPortfolioLocal, verifyOwnerPortfolioMigration,
  type OwnerPortfolioLocal } from '@/utils/ownerPortfolioLocal'
import { validateOwnerPortfolioUpgradeIntent, verifyOwnerPortfolioUpgradeIntent,
  type OwnerPortfolioUpgradeIntent } from '@/utils/owner-portfolio-upgrade-intent'
import type { CloudUpgradeHost, OwnerWorkspace, OwnerWorkspaceErrorCode, OwnerWorkspaceGuard,
  OwnerWorkspaceLocalState } from './owner-workspace-types'

export const OWNER_WORKSPACE_PORTFOLIO_UPGRADE_FORMAT = 'sinan-owner-portfolio-upgrade-1' as const
const OLD_STORES = [...STORES, SYNC]
const ALL_STORES = [...OLD_STORES, PORTFOLIO]
const INTENT = 'intent'
const encoder = new TextEncoder()
export interface OwnerWorkspacePortfolioUpgradeSource {
  readonly manualRaw: string | null
  readonly snapshotsRaw: string | null
}
export interface OwnerWorkspacePortfolioUpgradeBackup {
  readonly format: typeof OWNER_WORKSPACE_PORTFOLIO_UPGRADE_FORMAT
  readonly targetFingerprint: string
  readonly workspace: OwnerWorkspaceRecoveryBackup
  readonly source: OwnerWorkspacePortfolioUpgradeSource
}
export interface BuiltOwnerWorkspacePortfolioUpgradeBackup {
  readonly envelope: OwnerWorkspacePortfolioUpgradeBackup
  readonly raw: string
  readonly sha256: string
  readonly byteLength: number
}
export interface OwnerWorkspacePortfolioUpgradeRequest {
  readonly id: string
  readonly hash: string
  readonly backupRaw: string
  readonly backupSha256: string
}
interface CompiledUpgrade {
  readonly request: OwnerWorkspacePortfolioUpgradeRequest
  readonly expected: OwnerWorkspaceLocalState
  readonly portfolio: OwnerPortfolioLocal
  readonly intent: OwnerPortfolioUpgradeIntent
}
function portfolioRow(target: string, portfolio: OwnerPortfolioLocal) {
  return Object.freeze({ schema: 'owner-workspace-portfolio-1' as const, targetFingerprint: target, portfolio })
}
function checkedPortfolioRow(target: string, input: unknown): OwnerPortfolioLocal {
  if (!closed(input, ['schema', 'targetFingerprint', 'portfolio']) || input.schema !== 'owner-workspace-portfolio-1'
    || input.targetFingerprint !== target) fail('workspace_invalid_database')
  return validateOwnerPortfolioLocal(input.portfolio)
}

function bounded(raw: unknown): string {
  if (typeof raw !== 'string') fail('workspace_invalid_input')
  if (raw.length > OWNER_WORKSPACE_BACKUP_MAX_BYTES || encoder.encode(raw).byteLength > OWNER_WORKSPACE_BACKUP_MAX_BYTES) fail('workspace_capacity')
  // A file SHA must never silently hash TextEncoder's replacement characters.
  for (let index = 0; index < raw.length; index++) {
    const unit = raw.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = raw.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('workspace_invalid_input')
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail('workspace_invalid_input')
  }
  return raw
}
function source(input: unknown): OwnerWorkspacePortfolioUpgradeSource {
  if (!closed(input, ['manualRaw', 'snapshotsRaw'])) fail('workspace_invalid_input')
  // Invalid JSON and oversized legacy business collections can still be backed
  // up, but are never made a successful migration by dropping their contents.
  return Object.freeze({ manualRaw: input.manualRaw === null ? null : bounded(input.manualRaw),
    snapshotsRaw: input.snapshotsRaw === null ? null : bounded(input.snapshotsRaw) })
}
async function envelope(input: unknown, target: string): Promise<OwnerWorkspacePortfolioUpgradeBackup> {
  if (!closed(input, ['format', 'targetFingerprint', 'workspace', 'source'])
    || input.format !== OWNER_WORKSPACE_PORTFOLIO_UPGRADE_FORMAT || input.targetFingerprint !== target) fail('workspace_invalid_input')
  const rawSource = source(input.source)
  let workspace: OwnerWorkspaceRecoveryBackup
  try { workspace = await validateOwnerWorkspaceRecoveryBackup(input.workspace) }
  catch { return fail('workspace_invalid_input') }
  if (workspace.physicalVersion !== 4 || workspace.targetFingerprint !== target
    || !workspace.local.sync || Object.prototype.hasOwnProperty.call(workspace.local, 'portfolio')) fail('workspace_invalid_input')
  const result = Object.freeze({ format: OWNER_WORKSPACE_PORTFOLIO_UPGRADE_FORMAT, targetFingerprint: target, workspace, source: rawSource })
  bounded(canonicalOwnerLocal(result))
  return result
}

/** This is a protective file, not a write or migration preview. Even bad legacy
 * JSON remains in it unchanged so users do not lose data to obtain an export.
 */
export async function buildOwnerWorkspacePortfolioUpgradeBackup(target: string, expected: OwnerWorkspaceLocalState,
  rawSource: OwnerWorkspacePortfolioUpgradeSource): Promise<BuiltOwnerWorkspacePortfolioUpgradeBackup> {
  localId(target, 'portfolio-upgrade-backup')
  const checkedSource = source(rawSource)
  const workspace = await buildOwnerWorkspaceRecoveryBackup(target, expected)
  const checked = await envelope({ format: OWNER_WORKSPACE_PORTFOLIO_UPGRADE_FORMAT,
    targetFingerprint: target, workspace: workspace.envelope, source: checkedSource }, target)
  const raw = bounded(canonicalOwnerLocal(checked))
  return Object.freeze({ envelope: checked, raw, sha256: await digest(raw), byteLength: encoder.encode(raw).byteLength })
}
/** Re-select an exact protective file even when its source has migration issues.
 * This validates bytes and the old workspace; it does not approve a migration.
 */
export async function restoreOwnerWorkspacePortfolioUpgradeBackup(raw: unknown,
  expectedSha256: unknown): Promise<OwnerWorkspacePortfolioUpgradeBackup> {
  const bytes = bounded(raw)
  if (typeof expectedSha256 !== 'string' || !HASH.test(expectedSha256)
    || await digest(bytes) !== expectedSha256) fail('workspace_invalid_input')
  let parsed: unknown
  try { parsed = parseOwnerBusinessJson(bytes, OWNER_WORKSPACE_BACKUP_MAX_BYTES, 12) }
  catch { return fail('workspace_invalid_input') }
  if (!closed(parsed, ['format', 'targetFingerprint', 'workspace', 'source'])
    || typeof parsed.targetFingerprint !== 'string' || !HASH.test(parsed.targetFingerprint)) fail('workspace_invalid_input')
  const checked = await envelope(parsed, parsed.targetFingerprint)
  if (canonicalOwnerLocal(checked) !== bytes) fail('workspace_invalid_input')
  return checked
}
async function compile(target: string,
  input: Omit<OwnerWorkspacePortfolioUpgradeRequest, 'hash'>): Promise<CompiledUpgrade> {
  if (!closed(input, ['id', 'backupRaw', 'backupSha256'])) fail('workspace_invalid_input')
  localId(target, input.id)
  const raw = bounded(input.backupRaw)
  const checked = await restoreOwnerWorkspacePortfolioUpgradeBackup(raw, input.backupSha256)
  if (checked.targetFingerprint !== target) fail('workspace_invalid_input')
  const expected = checked.workspace.local
  if (!expected.metadata.adoption || expected.receiptCount !== 0 || expected.outbox.entry !== null
    || !expected.sync || expected.sync.pending !== null) fail('workspace_pending')
  if (input.id === expected.metadata.adoption.id) fail('workspace_idempotency_conflict')
  let portfolio: OwnerPortfolioLocal
  try {
    const preview = await previewOwnerPortfolioMigration(checked.source)
    if (preview.issues.length || !preview.portfolio || !preview.sourceSha256) fail('workspace_invalid_input')
    portfolio = await verifyOwnerPortfolioMigration(preview.portfolio)
  } catch { return fail('workspace_invalid_input') }
  const hash = await digest(canonical({ operation: 'portfolio-upgrade-1', target, id: input.id, backupSha256: input.backupSha256 }))
  const request = Object.freeze({ id: input.id, hash, backupRaw: raw, backupSha256: input.backupSha256 })
  const intent = await verifyOwnerPortfolioUpgradeIntent({ schema: 'owner-portfolio-upgrade-intent-1', targetFingerprint: target,
    id: request.id, hash: request.hash, backupSha256: request.backupSha256, sourceSha256: portfolio.migration.sourceSha256 },
  target, portfolio.migration.sourceSha256)
  // Reject a full v5 image which cannot be exported before versionchange can
  // commit. The core fixes all codecs and the shared complete-image capacity.
  const { validateOwnerWorkspaceLocalState } = await import('./owner-workspace')
  await validateOwnerWorkspaceLocalState(target, { ...expected, portfolio, portfolioUpgrade: intent })
  return Object.freeze({ request, expected, portfolio, intent })
}
export async function buildOwnerWorkspacePortfolioUpgradeRequest(target: string,
  input: Omit<OwnerWorkspacePortfolioUpgradeRequest, 'hash'>): Promise<OwnerWorkspacePortfolioUpgradeRequest> {
  return (await compile(target, input)).request
}
async function checkRequest(target: string, input: OwnerWorkspacePortfolioUpgradeRequest): Promise<CompiledUpgrade> {
  if (!closed(input, ['id', 'hash', 'backupRaw', 'backupSha256'])) fail('workspace_invalid_input')
  const compiled = await compile(target, { id: input.id, backupRaw: input.backupRaw, backupSha256: input.backupSha256 })
  if (input.hash !== compiled.request.hash) fail('workspace_invalid_input')
  return compiled
}

/** The complete old image is re-read within each actual write transaction.
 * All shape/relationship validation here is synchronous; crypto ran beforehand.
 */
function readExpected(host: CloudUpgradeHost, tx: IDBTransaction, expected: OwnerWorkspaceLocalState,
  guard: OwnerWorkspaceGuard, accept: () => void, reject: (problem: OwnerWorkspaceErrorCode) => void): void {
  try {
    assertGuard(guard)
    for (const name of OLD_STORES) {
      const store = tx.objectStore(name)
      if (store.keyPath !== null || store.autoIncrement || store.indexNames.length) fail('workspace_invalid_database')
    }
    const slot = tx.objectStore('slot'), working = tx.objectStore(WORKING), metadata = tx.objectStore(METADATA), sync = tx.objectStore(SYNC)
    const reads = [slot.get(CURRENT), slot.count(), working.get(CURRENT), working.count(), metadata.get(CURRENT), metadata.count(),
      tx.objectStore(RECEIPTS).count(), sync.get(CURRENT), sync.count()]
    let remaining = reads.length
    for (const read of reads) read.onsuccess = () => {
      if (--remaining) return
      try {
        assertGuard(guard)
        if (reads[1].result !== 1 || reads[3].result !== 1 || reads[5].result !== 1 || reads[6].result !== 0 || reads[8].result !== 1) fail('workspace_invalid_database')
        const snapshot = host.working(reads[2].result, host.target).snapshot
        const row = ownerSyncOutboxStorage.rowShape(reads[0].result, host.target)
        const local = host.localState({ snapshot, metadata: host.checkedMetadata(reads[4].result, snapshot),
          outbox: { version: row.version, entry: row.entry }, receiptCount: reads[6].result, sync: reads[7].result }, host.target)
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
        try { tx?.abort() } catch { /* A committed versionchange remains visible. */ }
        handle?.close(); db?.close(); reject(new OwnerWorkspaceError(problem))
      } else resolve(handle!)
    }
    const abort = () => finish(abortCode())
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try {
      assertGuard(guard)
      const request = upgrading ? factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + host.target, 5)
        : factory.open(OWNER_SYNC_OUTBOX_DB_PREFIX + host.target)
      request.onblocked = () => finish('workspace_blocked')
      request.onerror = () => finish('workspace_invalid_database')
      request.onupgradeneeded = event => {
        db = request.result; tx = request.transaction!
        if (settled || !upgrading || event.oldVersion !== 4 || !exactStores(db, OLD_STORES)) {
          try { tx.abort() } catch { /* Fail closed, including a missing database. */ }
          finish('workspace_invalid_database'); return
        }
        readExpected(host, tx, compiled.expected, guard, () => {
          if (settled) return
          assertGuard(guard)
          const store = db!.createObjectStore(PORTFOLIO)
          store.add(compiled.intent, INTENT)
        }, finish)
      }
      request.onsuccess = () => {
        db = request.result
        if (settled) { db.close(); return }
        db.onversionchange = () => finish('workspace_closed')
        db.onclose = () => finish('workspace_closed')
        try {
          assertGuard(guard)
          if (db.version !== 5 || !exactStores(db, ALL_STORES) || !isOwnerSyncOutboxDatabase(db)) fail('workspace_invalid_database')
          tx = db.transaction(ALL_STORES, 'readwrite', { durability: 'strict' })
          if (tx.durability !== 'strict') fail('workspace_unavailable')
          const portfolio = tx.objectStore(PORTFOLIO)
          if (portfolio.keyPath !== null || portfolio.autoIncrement || portfolio.indexNames.length) fail('workspace_invalid_database')
          const get = portfolio.get(CURRENT), count = portfolio.count(), intent = portfolio.get(INTENT)
          let got = false, counted = false, gotIntent = false
          const ready = () => {
            if (!got || !counted || !gotIntent || settled) return
            readExpected(host, tx!, compiled.expected, guard, () => {
              if (settled) return
              const checkedIntent = validateOwnerPortfolioUpgradeIntent(intent.result, host.target, compiled.portfolio.migration.sourceSha256)
              if (canonical(checkedIntent) !== canonical(compiled.intent)) fail('workspace_idempotency_conflict')
              if (count.result === 1 && get.result === undefined) {
                assertGuard(guard); portfolio.add(portfolioRow(host.target, compiled.portfolio), CURRENT)
              } else if (!upgrading && count.result === 2 && get.result !== undefined) {
                const checked = checkedPortfolioRow(host.target, get.result)
                if (canonical(checked) !== canonical(compiled.portfolio)) fail('workspace_conflict')
              } else fail('workspace_invalid_database')
            }, finish)
          }
          get.onsuccess = () => { got = true; ready() }
          count.onsuccess = () => { counted = true; ready() }
          intent.onsuccess = () => { gotIntent = true; ready() }
          tx.onerror = () => finish(code(tx?.error, 'workspace_aborted'))
          tx.onabort = () => finish(code(tx?.error, 'workspace_aborted'))
          tx.oncomplete = () => {
            if (settled) { db?.close(); return }
            try {
              assertGuard(guard)
              handle = host.makeWorkspace(db!, host.target)
              handle.readLocalState(guard).then(state => {
                if (canonical(state.portfolio) !== canonical(compiled.portfolio)
                  || canonical(state.portfolioUpgrade) !== canonical(compiled.intent)) finish('workspace_conflict')
                else finish()
              }, error => finish(code(error)))
            } catch (error) { finish(code(error)) }
          }
        } catch (error) { finish(code(error)) }
      }
    } catch (error) { finish(code(error)) }
  })
}

export async function upgradeOwnerWorkspacePortfolio(host: CloudUpgradeHost, factory: IDBFactory,
  input: OwnerWorkspacePortfolioUpgradeRequest, guard: OwnerWorkspaceGuard, signal: AbortSignal,
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
  if (version !== 4) fail('workspace_invalid_database')
  assertGuard(guard)
  return initialize(host, factory, compiled, guard, signal, abortCode, true)
}

/** No version argument: never upgrades an old v4 or creates a missing database.
 * Only the same original v4 image and the empty/exact initial v5 current qualify.
 */
export async function reconcileOwnerWorkspacePortfolioUpgrade(host: CloudUpgradeHost, factory: IDBFactory,
  input: OwnerWorkspacePortfolioUpgradeRequest, guard: OwnerWorkspaceGuard, signal: AbortSignal,
  abortCode: () => OwnerWorkspaceErrorCode): Promise<OwnerWorkspace> {
  assertGuard(guard)
  const compiled = await checkRequest(host.target, input)
  assertGuard(guard)
  return initialize(host, factory, compiled, guard, signal, abortCode, false)
}
