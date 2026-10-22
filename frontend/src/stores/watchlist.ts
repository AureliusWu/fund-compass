import { defineStore } from 'pinia'
import { ref, shallowRef, computed, onScopeDispose } from 'vue'
import * as gist from '@/utils/gist'
import type { WatchEntry } from '@/utils/gist'
import { entryId, migrateEntries } from '@/utils/gist'
import { getLegacySyncConsent, setLegacySyncConsent, getLegacySyncGeneration, subscribeLegacySyncConsent } from '@/utils/cloud-consent'
import { positionKind, validateHolding, WatchMutationError, type HoldingInput, type EntrySnapshot } from '@/utils/holding-editor'
import { openOwnerAuthority, OWNER_AUTHORITY_SEEN_HINT, type OwnerAuthority, type OwnerAuthorityRecord } from './owner-authority'
import type { OwnerWorkspace, OwnerWorkspaceGuard, OwnerWorkspaceLocalState, OwnerWorkspaceLocalCommand } from './owner-workspace'
import type { BuiltOwnerWorkspaceBackup, OwnerWorkspaceBackup, OwnerWorkspaceRestorePreview } from '@/utils/owner-workspace-backup'

const LS = 'sinan_watchlist_v2'
const LEGACY_LS = 'sinan_watchlist_v1'
const PUSH_DELAY = 4000
const nowISO = () => new Date().toISOString()
/** Local IDB records may have no historical display timestamp; never fabricate a Gist wire timestamp. */
export type WatchViewEntry = Omit<WatchEntry, 'updated_at'> & { updated_at: string | null; local_pending?: true }
type LocalWatchEntry = WatchViewEntry
export type OwnerAuthorityState = 'unresolved' | 'legacy' | 'activating' | 'idb' | 'blocked'
export interface LocalWorkspaceCounts { total: number; watch: number; holding: number; tombstones: number; localPending: number }
export type LocalWorkspaceBackup = BuiltOwnerWorkspaceBackup & { readonly counts: LocalWorkspaceCounts }
export type LocalWorkspaceRestorePreview = OwnerWorkspaceRestorePreview & {
  readonly counts: Readonly<{ total: number; added: number; noops: number; conflicts: number }>
}
export interface OwnerSyncWatchSource {
  readonly sourceKey: typeof LS | typeof LEGACY_LS | null
  readonly v1Raw: string | null
  readonly v2Raw: string | null
}
export interface OwnerSyncWatchSnapshot {
  readonly entries: readonly Readonly<WatchEntry & { local_pending?: true }>[]
  /** Compatibility field: original v2 slot only; the selected source is explicit below. */
  readonly raw: string | null
  readonly source: OwnerSyncWatchSource
  readonly memory: string
  readonly generation: number
}
const idOf = (entry: Pick<WatchEntry, 'id' | 'code' | 'account'>) => entry.id || entryId(entry.code, entry.account)
const clone = (entries: LocalWatchEntry[]) => entries.map(entry => ({ ...entry }))

function parseStored(raw: string): { rows: LocalWatchEntry[]; error: boolean } {
  try {
    const rows: unknown = JSON.parse(raw)
    if (!Array.isArray(rows) || !rows.every(row => row && typeof row === 'object'
      && typeof row.code === 'string' && /^\d{6}$/.test(row.code)
      && typeof row.updated_at === 'string'
      && (row.account == null || typeof row.account === 'string')
      && (row.id == null || row.id === entryId(row.code, row.account))
      && (row.position_kind == null || ['holding', 'watch'].includes(row.position_kind))
      && (row.local_pending == null || row.local_pending === true)
      && (row.deleted == null || typeof row.deleted === 'boolean')
      && ['shares', 'cost', 'target_weight'].every(key => row[key] == null
        || (typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0
          && (key !== 'target_weight' || row[key] <= 100))))) return { rows: [], error: true }
    const migrated = migrateEntries((rows as WatchEntry[]).map(row => ({ ...row })))
    if (new Set(migrated.map(idOf)).size !== migrated.length) return { rows: [], error: true }
    return { rows: migrated, error: false }
  } catch { return { rows: [], error: true } }
}

function readSources(): OwnerSyncWatchSource {
  // Read both original slots even when v2 is authoritative. An inaccessible or
  // changed legacy source must not silently become an empty/stable archive.
  const v2Raw = localStorage.getItem(LS), v1Raw = localStorage.getItem(LEGACY_LS)
  return { sourceKey: v2Raw !== null ? LS : v1Raw !== null ? LEGACY_LS : null, v1Raw, v2Raw }
}
function sameSource(first: OwnerSyncWatchSource | null, second: OwnerSyncWatchSource | null): boolean {
  return Boolean(first && second && first.sourceKey === second.sourceKey
    && first.v1Raw === second.v1Raw && first.v2Raw === second.v2Raw)
}
function selectedRaw(source: OwnerSyncWatchSource): string {
  return (source.sourceKey === LS ? source.v2Raw : source.v1Raw) ?? '[]'
}
function loadLS(): { rows: LocalWatchEntry[]; error: boolean; source: OwnerSyncWatchSource | null } {
  try {
    const source = readSources()
    return { ...parseStored(selectedRaw(source)), source }
  } catch { return { rows: [], error: true, source: null } }
}

export const useWatchlistStore = defineStore('watchlist', () => {
  // No business LS, Gist configuration or old rows are read before the fixed
  // application locator has been checked. A transient empty view is not ready.
  const entries = ref<LocalWatchEntry[]>([])
  const authorityState = ref<OwnerAuthorityState>('unresolved')
  const authorityError = ref('')
  const localStorageError = ref(false)
  const externalUnconfirmed = ref(false)
  let sourceBaseline: OwnerSyncWatchSource | null = null
  // Startup v1 fallback is compatible only before this store has observed v2.
  // Once v2 exists, deleting it cannot revive an older archived v1 ledger.
  let observedV2 = false
  const loaded = ref(false)
  const syncing = ref(false)
  const lastSync = ref('')
  const hasToken = ref(false)
  const legacySyncEnabled = ref(false)
  const localStatus = computed(() => authorityState.value === 'idb'
    ? '本机 IDB 工作区；未上传，不代表已确认持仓版本'
    : authorityState.value === 'unresolved' ? '正在核对本机权威存储，尚未加载记录'
    : authorityState.value === 'activating' ? '本机切换待手动核对，编辑暂停；不会重导旧数据'
    : authorityState.value === 'blocked' ? '本机权威存储无法安全核对，编辑暂停；未回退旧存储'
    : '本地工作副本；尚未同步至新版私人存储，不代表已确认持仓版本')
  let locator: OwnerAuthority | null = null, locatorRecord: OwnerAuthorityRecord | null = null
  let workspace: OwnerWorkspace | null = null, localState: OwnerWorkspaceLocalState | null = null
  let initialization: Promise<void> | null = null, alive = true
  const lifetime = new AbortController()
  let exported: { value: LocalWorkspaceBackup; legacy: OwnerSyncWatchSnapshot | null } | null = null
  let restorePreview: { raw: string; sha256: string; backup: OwnerWorkspaceBackup; expected: OwnerWorkspaceLocalState; value: LocalWorkspaceRestorePreview } | null = null
  const pendingLocal = shallowRef<{ id: string; hash: string } | null>(null)
  const hasPendingLocalWorkspaceEdit = computed(() => pendingLocal.value !== null)
  let localWriteInFlight = false
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  let mutationGeneration = 0
  let credentialGeneration = 0
  let requestGeneration = 0
  let unsubscribe = () => {}
  let eventChannel: BroadcastChannel | null = null
  try {
    if (typeof BroadcastChannel === 'function') eventChannel = new BroadcastChannel('fund-compass-owner-authority-events')
  } catch { /* This optional hint cannot disable the checked IDB authority path. */ }
  const notifyAuthority = () => { try { eventChannel?.postMessage('recheck') } catch { /* each operation also reads the locator */ } }
  function suspendLegacy() {
    cancelPush(); mutationGeneration++; credentialGeneration++; requestGeneration++; syncing.value = false
    legacySyncEnabled.value = false; hasToken.value = false; lastSync.value = ''
    setLegacySyncConsent(false) // also aborts in-flight gist.withCloud requests
  }
  function block(cause?: unknown) {
    authorityState.value = 'blocked'; localStorageError.value = true; cancelPush(); requestGeneration++
    authorityError.value = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
      ? cause.code : '本机权威存储无法安全核对'
  }
  function activeGuard(extra: () => void = () => {}): OwnerWorkspaceGuard {
    return { signal: lifetime.signal, assertActive() { if (!alive || lifetime.signal.aborted) throw new WatchMutationError('storage'); extra() } }
  }
  function acceptLocal(state: OwnerWorkspaceLocalState) {
    if (!alive) throw new WatchMutationError('storage')
    const times = new Map(state.metadata.displayTimes.map(row => [row.key, row.updated_at]))
    const next = state.snapshot.entries.map(row => {
      const separator = row.key.indexOf('::')
      return { id: row.key, code: row.key.slice(0, separator), account: row.key.slice(separator + 2),
        name: row.values.name, position_kind: row.kind, shares: row.values.shares, cost: row.values.cost,
        target_weight: row.values.target_weight, deleted: row.deleted, updated_at: times.get(row.key) ?? null,
        ...(row.local_pending ? { local_pending: true as const } : {}) }
    })
    entries.value = next; localState = state; localStorageError.value = false; mutationGeneration++
    exported = null; restorePreview = null
  }
  async function verifyAuthority(phase: 'legacy' | 'active') {
    if (!alive || !locator || !locatorRecord) throw new WatchMutationError('storage')
    let current: OwnerAuthorityRecord
    try { current = await locator.read() }
    catch (cause) { if (alive) block(cause); throw cause }
    if (!alive) throw new WatchMutationError('storage')
    if (current.phase !== phase || JSON.stringify(current) !== JSON.stringify(locatorRecord)) {
      locatorRecord = current
      if (current.phase !== 'legacy') suspendLegacy()
      authorityState.value = current.phase === 'activating' ? 'activating' : 'blocked'
      authorityError.value = '本机权威已在另一页面改变，请重新加载并核对'
      throw new WatchMutationError('conflict')
    }
  }
  async function initialize(): Promise<void> {
    if (initialization) return initialization
    initialization = (async () => {
      try {
        let hint: Storage | null = null
        try { hint = localStorage } catch { /* no readable marker means new metadata cannot be created */ }
        const handle = await openOwnerAuthority(globalThis.indexedDB, hint)
        if (!alive) { handle.close(); throw new WatchMutationError('storage') }
        locator = handle; locatorRecord = await handle.read()
        if (!alive) throw new WatchMutationError('storage')
        if (locatorRecord.phase === 'legacy') {
          const initial = loadLS()
          entries.value = initial.rows; localStorageError.value = initial.error; sourceBaseline = initial.source
          observedV2 = initial.source?.sourceKey === LS; authorityState.value = 'legacy'
          lastSync.value = gist.getSyncTime(); hasToken.value = gist.hasConfig(); legacySyncEnabled.value = getLegacySyncConsent()
          unsubscribe = subscribeLegacySyncConsent(() => {
            legacySyncEnabled.value = authorityState.value === 'legacy' && getLegacySyncConsent()
            cancelPush(); requestGeneration++; syncing.value = false
          })
        } else {
          suspendLegacy()
          const module = await import('./owner-workspace')
          const handle = await module.openOwnerWorkspace(globalThis.indexedDB, locatorRecord.targetFingerprint!, { existingOnly: true })
          if (!alive) { handle.close(); throw new WatchMutationError('storage') }
          workspace = handle
          const state = await handle.readLocalState(activeGuard())
          const adoption = state.metadata.adoption
          if (adoption && (adoption.id !== locatorRecord.activationId || adoption.backupSha256 !== locatorRecord.backupSha256)) throw new WatchMutationError('storage')
          if (locatorRecord.phase === 'active') {
            if (!adoption) throw new WatchMutationError('storage')
            acceptLocal(state); authorityState.value = 'idb'
          } else {
            authorityState.value = 'activating'
            authorityError.value = adoption ? '请重新选择原备份文件，手动核对已保存的切换回执'
              : '没有匹配的切换回执；保留原备份，不能自动重导或重试'
          }
        }
      } catch (cause) { if (alive) block(cause); throw cause }
    })()
    return initialization
  }
  async function ready() {
    if (authorityState.value === 'unresolved') await initialize()
    if (authorityState.value !== 'legacy' && authorityState.value !== 'idb') throw new WatchMutationError('storage')
    await verifyAuthority(authorityState.value === 'legacy' ? 'legacy' : 'active')
  }
  if (eventChannel) eventChannel.onmessage = () => {
    if (alive && locatorRecord) void verifyAuthority(locatorRecord.phase === 'legacy' ? 'legacy' : 'active').catch(() => {})
  }

  const items = computed(() => {
    const seen = new Map<string, WatchViewEntry>()
    for (const entry of entries.value) {
      if (entry.deleted) continue
      const current = seen.get(entry.code)
      if (!current || (!(current.shares && current.shares > 0) && entry.shares != null && entry.shares > 0)) seen.set(entry.code, entry)
    }
    return [...seen.values()].map(entry => ({ code: entry.code, name: entry.name ?? null, type: null as string | null, added_at: entry.updated_at }))
  })
  function cancelPush() { if (pushTimer) clearTimeout(pushTimer); pushTimer = null }
  function invalidateExternalState() {
    externalUnconfirmed.value = true
    cancelPush()
    mutationGeneration++
    requestGeneration++
    syncing.value = false
  }
  function assertStorageBaseline() {
    if (authorityState.value !== 'legacy') throw new WatchMutationError('storage')
    let current: OwnerSyncWatchSource
    try { current = readSources() }
    catch {
      localStorageError.value = true
      invalidateExternalState()
      throw new WatchMutationError('storage')
    }
    if (current.v2Raw !== null) observedV2 = true
    if (observedV2 && current.v2Raw === null) {
      localStorageError.value = true
      invalidateExternalState()
      throw new WatchMutationError('storage')
    }
    if (!sameSource(current, sourceBaseline)) {
      invalidateExternalState()
      throw new WatchMutationError('conflict')
    }
    return current
  }
  function storageChanged(event: StorageEvent) {
    if (event.key === OWNER_AUTHORITY_SEEN_HINT) {
      if (locatorRecord) void verifyAuthority(locatorRecord.phase === 'legacy' ? 'legacy' : 'active').catch(() => {})
      return
    }
    if (authorityState.value === 'activating' && (event.key === LS || event.key === LEGACY_LS || event.key === null)) {
      invalidateExternalState(); return
    }
    if (authorityState.value !== 'legacy') return
    if (event.key !== LS && event.key !== LEGACY_LS && event.key !== null) return
    let source: OwnerSyncWatchSource
    try {
      if (event.storageArea && event.storageArea !== localStorage) return
      // Read both current slots, not a possibly queued old event's payload.
      source = readSources()
    } catch {
      localStorageError.value = true
      invalidateExternalState()
      return
    }
    // Every observed relevant event invalidates old previews and responses,
    // even when queued ABA has returned the raw bytes to their previous value.
    // This cannot discover unobserved ABA or provide cross-tab atomic CAS.
    invalidateExternalState()
    if (source.v2Raw !== null) observedV2 = true
    if (observedV2 && source.v2Raw === null) {
      localStorageError.value = true
      return // Keep the last accepted source and working copy; never revive v1.
    }
    const parsed = parseStored(selectedRaw(source))
    if (parsed.error) {
      // Keep both the malformed disk data and the previous working copy.
      localStorageError.value = true
      return
    }
    entries.value = parsed.rows
    sourceBaseline = source
    localStorageError.value = false
  }
  const storageWindow = typeof window === 'undefined' ? null : window
  storageWindow?.addEventListener('storage', storageChanged)
  onScopeDispose(() => {
    alive = false; lifetime.abort(); cancelPush(); unsubscribe(); requestGeneration++
    workspace?.close(); locator?.close(); eventChannel?.close()
    storageWindow?.removeEventListener('storage', storageChanged)
  })
  const canSync = () => authorityState.value === 'legacy' && getLegacySyncConsent() && gist.hasConfig()

  function commit(next: LocalWatchEntry[]) {
    if (localStorageError.value) throw new WatchMutationError('storage')
    const source = assertStorageBaseline()
    const serialized = JSON.stringify(next)
    // This observed-raw guard is not an atomic cross-tab transaction or Owner
    // revision. Native getItem + setItem cannot provide that stronger guarantee.
    try { localStorage.setItem(LS, serialized) }
    catch {
      localStorageError.value = true
      invalidateExternalState()
      throw new WatchMutationError('storage')
    }
    sourceBaseline = { ...source, sourceKey: LS, v2Raw: serialized }
    observedV2 = true
    entries.value = next
    mutationGeneration++
  }
  function entrySnapshot(id: string): string | null {
    const entry = entries.value.find(row => idOf(row) === id && !row.deleted)
    return entry ? JSON.stringify(entry) : null
  }
  function readOwnerSyncSnapshot(): OwnerSyncWatchSnapshot {
    if (localStorageError.value) throw new WatchMutationError('storage')
    const source = assertStorageBaseline()
    try {
      const memory = JSON.stringify(entries.value)
      const copy = clone(entries.value).map(entry => {
        if (typeof entry.updated_at !== 'string') throw new WatchMutationError('storage')
        return Object.freeze({ ...entry, updated_at: entry.updated_at })
      })
      return Object.freeze({ raw: source.v2Raw, source: Object.freeze({ ...source }), memory, generation: mutationGeneration,
        entries: Object.freeze(copy) })
    } catch { throw new WatchMutationError('invalid') }
  }
  function assertOwnerSyncSnapshot(snapshot: OwnerSyncWatchSnapshot): void {
    if (localStorageError.value) throw new WatchMutationError('storage')
    assertStorageBaseline()
    try {
      if (!snapshot || snapshot.raw !== sourceBaseline?.v2Raw || !sameSource(snapshot.source, sourceBaseline)
        || snapshot.generation !== mutationGeneration
        || snapshot.memory !== JSON.stringify(entries.value)
        || JSON.stringify(snapshot.entries) !== snapshot.memory) throw new WatchMutationError('conflict')
    } catch { throw new WatchMutationError('conflict') }
    // Observed-raw/generation guard only, not an atomic cross-tab transaction
    // or an Owner revision. It never clears local_pending/externalUnconfirmed.
  }
  const recordsFor = (code: string) => entries.value.filter(entry => entry.code === code && !entry.deleted)
  // Entry flags are preserved backup history, not proof of a confirmed
  // revision -> Holding/Policy/Decision chain for this local-only authority.
  const hasLocalChanges = (code?: string) => authorityState.value !== 'legacy' || localStorageError.value || externalUnconfirmed.value
    || entries.value.some(entry => entry.local_pending === true && (code === undefined || entry.code === code))
  const localPending = computed(() => hasLocalChanges())
  function assertExpected(expected: EntrySnapshot[]) {
    if (expected.some(row => entrySnapshot(row.id) !== row.snapshot)) throw new WatchMutationError('conflict')
  }

  function counts(value: OwnerWorkspaceBackup): LocalWorkspaceCounts {
    return Object.freeze({ total: value.entries.length, watch: value.entries.filter(row => row.kind === 'watch').length,
      holding: value.entries.filter(row => row.kind === 'holding').length, tombstones: value.entries.filter(row => row.deleted).length,
      localPending: value.entries.filter(row => row.local_pending).length })
  }
  async function createLocalWorkspaceBackup(): Promise<LocalWorkspaceBackup> {
    await ready()
    const module = await import('@/utils/owner-workspace-backup')
    let result: BuiltOwnerWorkspaceBackup, legacy: OwnerSyncWatchSnapshot | null = null
    if (authorityState.value === 'legacy') {
      legacy = readOwnerSyncSnapshot()
      result = await module.buildOwnerLegacyWorkspaceBackup(legacy.source)
      assertOwnerSyncSnapshot(legacy)
      await verifyAuthority('legacy')
      assertOwnerSyncSnapshot(legacy)
    } else {
      const state = await workspace!.readLocalState(activeGuard())
      acceptLocal(state)
      result = await module.buildOwnerWorkspaceBackup(state)
      const checked = await workspace!.readLocalState(activeGuard())
      if (module.canonicalOwnerLocal(checked) !== module.canonicalOwnerLocal(state)) throw new WatchMutationError('conflict')
      await verifyAuthority('active')
    }
    const value = Object.freeze({ ...result, counts: counts(result.envelope) })
    exported = { value, legacy }
    return value
  }
  async function activateLocalWorkspace(raw: string, sha256: string): Promise<void> {
    if (authorityState.value === 'unresolved') await initialize()
    const module = await import('@/utils/owner-workspace-backup')
    const backup = await module.restoreOwnerWorkspaceBackup(raw, sha256)
    if (!alive || !locator || !locatorRecord) throw new WatchMutationError('storage')
    if (authorityState.value === 'activating') {
      // Explicit manual completion only. Never re-run adoption after an unknown
      // commit or a crash between the two databases' commits.
      const current = await locator.read()
      if (!['activating', 'active'].includes(current.phase) || current.backupSha256 !== sha256
        || current.targetFingerprint !== locatorRecord.targetFingerprint || current.activationId !== locatorRecord.activationId) throw new WatchMutationError('conflict')
      const storage = await import('./owner-workspace')
      workspace?.close()
      const handle = await storage.openOwnerWorkspace(globalThis.indexedDB, current.targetFingerprint!, { existingOnly: true })
      if (!alive) { handle.close(); throw new WatchMutationError('storage') }
      workspace = handle
      const state = await workspace.readLocalState(activeGuard()), adoption = state.metadata.adoption
      if (!adoption || adoption.id !== current.activationId || adoption.backupSha256 !== sha256
        || module.canonicalOwnerLocal(adoption.sourceArchive) !== module.canonicalOwnerLocal(backup.sourceArchive)) throw new WatchMutationError('conflict')
      const original = await module.buildOwnerLegacyWorkspaceBackup(adoption.sourceArchive)
      if (original.raw !== raw || original.sha256 !== sha256) throw new WatchMutationError('conflict')
      locatorRecord = current.phase === 'activating' ? await locator.completeActivation(current) : current
      acceptLocal(state); authorityState.value = 'idb'; authorityError.value = ''; loaded.value = true; notifyAuthority()
      return
    }
    await ready()
    if (authorityState.value !== 'legacy' || !exported?.legacy || exported.value.raw !== raw || exported.value.sha256 !== sha256) throw new WatchMutationError('conflict')
    const snapshot = exported.legacy
    assertOwnerSyncSnapshot(snapshot)
    const [{ getOwnerSyncTargetFingerprint }, storage] = await Promise.all([import('./ownerSession'), import('./owner-workspace')])
    const target = await getOwnerSyncTargetFingerprint() // local endpoint hash only, no login or network
    assertOwnerSyncSnapshot(snapshot); await verifyAuthority('legacy'); assertOwnerSyncSnapshot(snapshot)
    const handle = await storage.openOwnerWorkspace(globalThis.indexedDB, target)
    if (!alive) { handle.close(); throw new WatchMutationError('storage') }
    workspace = handle
    const expected = await handle.readLocalState(activeGuard(() => assertOwnerSyncSnapshot(snapshot)))
    if (expected.outbox.entry !== null || expected.receiptCount !== 0 || expected.snapshot.localVersion !== 0
      || expected.snapshot.entries.length !== 0 || expected.snapshot.legacy !== null || expected.metadata.adoption !== null
      || expected.metadata.recentEdit !== null || expected.metadata.restoredArchives.length !== 0) throw new WatchMutationError('conflict')
    const request = await storage.buildOwnerWorkspaceAdoptLocalRequest(target, { id: 'local-adopt-' + crypto.randomUUID(), expected,
      sourceArchive: snapshot.source, backupSha256: sha256 })
    assertOwnerSyncSnapshot(snapshot); await verifyAuthority('legacy'); assertOwnerSyncSnapshot(snapshot)
    locatorRecord = await locator.beginActivation(locatorRecord!, target, request.id, sha256)
    authorityState.value = 'activating'; authorityError.value = ''; suspendLegacy(); notifyAuthority()
    // Revoking Gist intentionally invalidates Owner snapshots. Continue guarding
    // exactly the original source/memory, not the pre-revocation generation.
    const activationGeneration = mutationGeneration
    const activationGuard = activeGuard(() => {
      if (authorityState.value !== 'activating' || activationGeneration !== mutationGeneration
        || !sameSource(readSources(), snapshot.source) || JSON.stringify(entries.value) !== snapshot.memory) throw new WatchMutationError('conflict')
    })
    try {
      const state = await handle.adoptLocal(request, activationGuard)
      locatorRecord = await locator.completeActivation(locatorRecord)
      if (!alive) throw new WatchMutationError('storage')
      acceptLocal(state); authorityState.value = 'idb'; loaded.value = true; notifyAuthority()
    } catch (cause) {
      authorityError.value = '切换结果待手动核对。请保留原备份；不会重新导入或自动重试。'
      throw cause
    }
  }
  async function writeLocal(command: OwnerWorkspaceLocalCommand): Promise<void> {
    if (localWriteInFlight) throw new WatchMutationError('conflict')
    localWriteInFlight = true
    try {
      const storage = await import('./owner-workspace')
      const expected = localState!
      const request = await storage.buildOwnerWorkspaceEditLocalRequest(workspace!.targetFingerprint,
        { id: 'local-edit-' + crypto.randomUUID(), expected, command })
      pendingLocal.value = { id: request.id, hash: request.hash }
      const generation = mutationGeneration, memory = JSON.stringify(entries.value)
      try {
        const state = await workspace!.editLocal(request, activeGuard(() => {
          if (authorityState.value !== 'idb' || generation !== mutationGeneration || JSON.stringify(entries.value) !== memory) throw new WatchMutationError('conflict')
        }))
        acceptLocal(state); pendingLocal.value = null
      } catch (cause) { block(cause); throw cause }
    } finally { localWriteInFlight = false }
  }
  async function reconcileLocalWorkspaceEdit(): Promise<void> {
    if (authorityState.value !== 'blocked' || !pendingLocal.value || !locatorRecord) throw new WatchMutationError('storage')
    await verifyAuthority('active')
    const original = pendingLocal.value, storage = await import('./owner-workspace')
    workspace?.close()
    const handle = await storage.openOwnerWorkspace(globalThis.indexedDB, locatorRecord.targetFingerprint!, { existingOnly: true })
    if (!alive) { handle.close(); throw new WatchMutationError('storage') }
    workspace = handle
    const checked = await handle.readLocalState(activeGuard()), adoption = checked.metadata.adoption
    if (!adoption || adoption.id !== locatorRecord.activationId || adoption.backupSha256 !== locatorRecord.backupSha256) throw new WatchMutationError('storage')
    const result = await handle.localReceipt(original.id, original.hash, activeGuard())
    if (result.state !== 'matched') throw new WatchMutationError('storage')
    acceptLocal(result.value); pendingLocal.value = null; authorityState.value = 'idb'; authorityError.value = ''
  }
  async function previewLocalWorkspaceRestore(raw: string, sha256: string): Promise<LocalWorkspaceRestorePreview> {
    await ready()
    if (authorityState.value !== 'idb') throw new WatchMutationError('storage')
    const module = await import('@/utils/owner-workspace-backup'), backup = await module.restoreOwnerWorkspaceBackup(raw, sha256)
    const expected = await workspace!.readLocalState(activeGuard())
    acceptLocal(expected)
    const preview = module.previewOwnerWorkspaceRestore(expected, backup)
    const value = Object.freeze({ ...preview, counts: Object.freeze({ total: preview.rows.length,
      added: preview.added, noops: preview.noops, conflicts: preview.conflicts }) })
    restorePreview = { raw, sha256, backup, expected, value }
    return value
  }
  async function restoreLocalWorkspaceBackup(raw: string, sha256: string): Promise<void> {
    await ready()
    if (authorityState.value !== 'idb' || !restorePreview || restorePreview.raw !== raw || restorePreview.sha256 !== sha256
      || restorePreview.value.conflicts !== 0) throw new WatchMutationError('conflict')
    const original = restorePreview
    const [module, storage] = await Promise.all([import('@/utils/owner-workspace-backup'), import('./owner-workspace')])
    const current = await workspace!.readLocalState(activeGuard())
    if (module.canonicalOwnerLocal(current) !== module.canonicalOwnerLocal(original.expected)) throw new WatchMutationError('conflict')
    if (original.value.added === 0) return // exact duplicates/empty files never overwrite or delete current entries
    if (localWriteInFlight) throw new WatchMutationError('conflict')
    localWriteInFlight = true
    try {
      const request = await storage.buildOwnerWorkspaceRestoreLocalRequest(workspace!.targetFingerprint,
        { id: 'local-restore-' + crypto.randomUUID(), expected: original.expected, backup: original.backup })
      const generation = mutationGeneration
      pendingLocal.value = { id: request.id, hash: request.hash }
      try {
        const state = await workspace!.restoreLocal(request, activeGuard(() => {
          if (authorityState.value !== 'idb' || restorePreview !== original || generation !== mutationGeneration) throw new WatchMutationError('conflict')
        }))
        acceptLocal(state); pendingLocal.value = null
      } catch (cause) { block(cause); throw cause }
    } finally { localWriteInFlight = false }
  }

  async function pull(): Promise<boolean> {
    try { await ready() } catch { return false }
    if (!canSync() || syncing.value || localStorageError.value) return false
    const consent = getLegacySyncGeneration(), credential = credentialGeneration, mutation = mutationGeneration, request = ++requestGeneration
    syncing.value = true
    try {
      const cloud = await gist.pullEntries()
      if (!cloud || !canSync() || consent !== getLegacySyncGeneration() || credential !== credentialGeneration
        || mutation !== mutationGeneration || request !== requestGeneration) return false
      // Cross-tab notifications are hints only. A persisted authority switch
      // during the network wait must win even if no hint has arrived yet.
      await verifyAuthority('legacy')
      if (!canSync() || consent !== getLegacySyncGeneration() || credential !== credentialGeneration
        || mutation !== mutationGeneration || request !== requestGeneration) return false
      const map = new Map(clone(entries.value).map(entry => [idOf(entry), entry]))
      for (const entry of cloud) {
        const id = idOf(entry), local = map.get(id)
        if (!local || local.updated_at === null || entry.updated_at > local.updated_at) map.set(id, { ...entry, id, local_pending: true })
      }
      commit([...map.values()])
      gist.confirmEntriesApplied()
      lastSync.value = gist.getSyncTime()
      return true
    } catch { return false }
    finally { if (request === requestGeneration) syncing.value = false }
  }
  async function push(): Promise<boolean> {
    try { await ready() } catch { return false }
    if (!canSync() || syncing.value || localStorageError.value) return false
    try { assertStorageBaseline() } catch { return false }
    const consent = getLegacySyncGeneration(), credential = credentialGeneration, mutation = mutationGeneration, request = ++requestGeneration
    // local_pending is never a cloud revision and must not cross the transport.
    const snapshot: WatchEntry[] = entries.value.map(({ local_pending: _local, ...entry }) => {
      if (typeof entry.updated_at !== 'string') throw new WatchMutationError('storage')
      return { ...entry, updated_at: entry.updated_at }
    })
    syncing.value = true
    try {
      const success = await gist.pushEntries(snapshot)
      if (!success || !canSync() || consent !== getLegacySyncGeneration() || credential !== credentialGeneration
        || request !== requestGeneration || mutation !== mutationGeneration) return false
      // This only gates local acknowledgement; it cannot undo an already sent
      // remote PATCH or the helper's previously written legacy sync metadata.
      await verifyAuthority('legacy')
      if (!canSync() || consent !== getLegacySyncGeneration() || credential !== credentialGeneration
        || request !== requestGeneration || mutation !== mutationGeneration) return false
      assertStorageBaseline()
      lastSync.value = gist.getSyncTime()
      return true
    } catch { return false }
    finally { if (request === requestGeneration) syncing.value = false }
  }
  function schedulePush() {
    cancelPush()
    if (canSync()) pushTimer = setTimeout(() => { pushTimer = null; void push() }, PUSH_DELAY)
  }
  async function load(force = false) {
    await initialize()
    await ready()
    if (authorityState.value === 'idb') {
      try {
        const state = await workspace!.readLocalState(activeGuard())
        acceptLocal(state); loaded.value = true; return
      } catch (cause) { if (alive) block(cause); throw cause }
    }
    if (loaded.value && !force) return
    // No confirmed revision exists yet: pruning unsynced tombstones could let an
    // old cloud copy resurrect deleted account rows when sync is enabled later.
    if (canSync()) await pull()
    loaded.value = true
  }
  function has(code: string, account?: string) {
    return entries.value.some(entry => !entry.deleted && (account !== undefined ? idOf(entry) === entryId(code, account) : entry.code === code))
  }

  async function saveHolding(input: HoldingInput, source?: EntrySnapshot, options: { confirmed?: boolean } = {}) {
    await ready()
    const value = validateHolding(input), id = entryId(value.code, value.account)
    const next = clone(entries.value)
    const previous = source ? next.find(entry => idOf(entry) === source.id && !entry.deleted) : undefined
    if (source) {
      assertExpected([source])
      if (!previous || previous.code !== value.code) throw new WatchMutationError('conflict')
      if (positionKind(previous) === 'holding' && value.position_kind === 'watch' && !options.confirmed) throw new WatchMutationError('requires-confirmation')
    }
    if (next.some(entry => !entry.deleted && idOf(entry) === id && idOf(entry) !== source?.id)) throw new WatchMutationError('conflict')
    if (authorityState.value === 'idb') {
      const expectedEntry = source ? localState!.snapshot.entries.find(entry => entry.key === source.id) ?? null
        : localState!.snapshot.entries.find(entry => entry.key === id && entry.deleted) ?? null
      await writeLocal({ type: 'save', input: value, expectedEntry, confirmed: options.confirmed === true })
      return
    }
    const timestamp = nowISO()
    if (previous && idOf(previous) !== id) { previous.deleted = true; previous.updated_at = timestamp; previous.local_pending = true }
    const replacement: LocalWatchEntry = { ...value, id, deleted: false, updated_at: timestamp, local_pending: true }
    const index = next.findIndex(entry => idOf(entry) === id)
    if (index >= 0) next[index] = replacement
    else next.push(replacement)
    commit(next)
    schedulePush()
  }
  async function add(code: string, name?: string) {
    await ready()
    if (has(code, '')) return
    // Explicitly re-adding a fund creates a watch record, never resurrects the
    // old tombstone's financial fields.
    await saveHolding({ code, name, account: '', position_kind: 'watch', shares: null, cost: null, target_weight: null })
  }
  async function remove(code: string, account?: string, options: { confirmed?: boolean; expected?: EntrySnapshot[] } = {}) {
    await ready()
    if (!/^\d{6}$/.test(code)) throw new WatchMutationError('invalid')
    const targets = recordsFor(code).filter(entry => account === undefined || idOf(entry) === entryId(code, account))
    if (options.expected) {
      assertExpected(options.expected)
      if (options.expected.length !== targets.length || targets.some(entry => !options.expected?.some(row => row.id === idOf(entry)))) throw new WatchMutationError('conflict')
    }
    if (!options.confirmed && (targets.length > 1 || targets.some(entry => positionKind(entry) === 'holding'))) throw new WatchMutationError('requires-confirmation')
    if (!targets.length) return
    if (authorityState.value === 'idb') {
      const keys = targets.map(idOf)
      await writeLocal({ type: 'remove', keys, expectedEntries: localState!.snapshot.entries.filter(entry => keys.includes(entry.key)), confirmed: options.confirmed === true })
      return
    }
    const ids = new Set(targets.map(idOf)), timestamp = nowISO()
    commit(clone(entries.value).map(entry => ids.has(idOf(entry)) ? { ...entry, deleted: true, updated_at: timestamp, local_pending: true as const } : entry))
    schedulePush()
  }
  async function toggle(code: string, name?: string) { await ready(); return has(code) ? remove(code) : add(code, name) }
  async function setHolding(code: string, shares: number, cost: number | null, name?: string, account?: string, targetWeight?: number | null) {
    await ready()
    const id = entryId(code, account), previous = entries.value.find(entry => idOf(entry) === id && !entry.deleted)
    await saveHolding({ code, name: name ?? previous?.name, account: account ?? '', position_kind: 'holding', shares, cost,
      target_weight: targetWeight === undefined ? previous?.target_weight ?? null : targetWeight }, previous ? { id, snapshot: JSON.stringify(previous) } : undefined)
  }
  function holdingsFor(code: string): WatchViewEntry[] {
    return recordsFor(code).filter(entry => positionKind(entry) === 'holding' && entry.shares != null && entry.shares > 0)
  }
  const accounts = computed(() => [...new Set(entries.value.filter(entry => !entry.deleted && entry.account?.trim()).map(entry => entry.account!.trim()))])
  const activeHoldings = computed(() => entries.value.filter(entry => !entry.deleted))
  function setToken(token: string) {
    if (authorityState.value !== 'legacy') throw new WatchMutationError('storage')
    setLegacySyncConsent(false); cancelPush(); credentialGeneration++; requestGeneration++; syncing.value = false
    gist.setToken(token.trim()); hasToken.value = gist.hasConfig()
  }
  function setLegacySyncEnabled(enabled: boolean) {
    if (authorityState.value !== 'legacy') throw new WatchMutationError('storage')
    setLegacySyncConsent(enabled)
  }
  function clearCloud() {
    setLegacySyncConsent(false); cancelPush(); credentialGeneration++; requestGeneration++; syncing.value = false
    gist.clearConfig(); hasToken.value = false; lastSync.value = ''
  }
  return {
    authorityState, authorityError, initialize, createLocalWorkspaceBackup, activateLocalWorkspace,
    previewLocalWorkspaceRestore, restoreLocalWorkspaceBackup, reconcileLocalWorkspaceEdit, hasPendingLocalWorkspaceEdit,
    items, entries, activeHoldings, accounts, loaded, syncing, lastSync, hasToken, legacySyncEnabled, localStorageError, localStatus,
    load, has, add, remove, toggle, setHolding, holdingsFor, recordsFor, saveHolding, entrySnapshot, hasLocalChanges, localPending,
    readOwnerSyncSnapshot, assertOwnerSyncSnapshot,
    setToken, setLegacySyncEnabled, manualUpload: push, manualDownload: pull, clearCloud, push, pull,
  }
})
