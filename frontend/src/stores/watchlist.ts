import { defineStore } from 'pinia'
import { ref, computed, onScopeDispose } from 'vue'
import * as gist from '@/utils/gist'
import type { WatchEntry } from '@/utils/gist'
import { entryId, migrateEntries } from '@/utils/gist'
import { getLegacySyncConsent, setLegacySyncConsent, getLegacySyncGeneration, subscribeLegacySyncConsent } from '@/utils/cloud-consent'
import { positionKind, validateHolding, WatchMutationError, type HoldingInput, type EntrySnapshot } from '@/utils/holding-editor'

const LS = 'sinan_watchlist_v2'
const LEGACY_LS = 'sinan_watchlist_v1'
const PUSH_DELAY = 4000
const nowISO = () => new Date().toISOString()
type LocalWatchEntry = WatchEntry & { local_pending?: true }
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
const idOf = (entry: WatchEntry) => entry.id || entryId(entry.code, entry.account)
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
    const migrated = migrateEntries(clone(rows))
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
  const initial = loadLS()
  const entries = ref<LocalWatchEntry[]>(initial.rows)
  const localStorageError = ref(initial.error)
  const externalUnconfirmed = ref(false)
  let sourceBaseline = initial.source
  // Startup v1 fallback is compatible only before this store has observed v2.
  // Once v2 exists, deleting it cannot revive an older archived v1 ledger.
  let observedV2 = initial.source?.sourceKey === LS
  const loaded = ref(false)
  const syncing = ref(false)
  const lastSync = ref(gist.getSyncTime())
  const hasToken = ref(gist.hasConfig())
  const legacySyncEnabled = ref(getLegacySyncConsent())
  const localStatus = '本地工作副本；尚未同步至新版私人存储，不代表已确认持仓版本'
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  let mutationGeneration = 0
  let credentialGeneration = 0
  let requestGeneration = 0

  const items = computed(() => {
    const seen = new Map<string, WatchEntry>()
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
  const unsubscribe = subscribeLegacySyncConsent(() => {
    legacySyncEnabled.value = getLegacySyncConsent()
    cancelPush()
    requestGeneration++
    syncing.value = false
  })
  onScopeDispose(() => {
    cancelPush(); unsubscribe(); requestGeneration++
    storageWindow?.removeEventListener('storage', storageChanged)
  })
  const canSync = () => getLegacySyncConsent() && gist.hasConfig()

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
      return Object.freeze({ raw: source.v2Raw, source: Object.freeze({ ...source }), memory, generation: mutationGeneration,
        entries: Object.freeze(clone(entries.value).map(entry => Object.freeze(entry))) })
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
  const hasLocalChanges = (code?: string) => localStorageError.value || externalUnconfirmed.value
    || entries.value.some(entry => entry.local_pending === true && (code === undefined || entry.code === code))
  const localPending = computed(() => hasLocalChanges())
  function assertExpected(expected: EntrySnapshot[]) {
    if (expected.some(row => entrySnapshot(row.id) !== row.snapshot)) throw new WatchMutationError('conflict')
  }

  async function pull(): Promise<boolean> {
    if (!canSync() || syncing.value || localStorageError.value) return false
    const consent = getLegacySyncGeneration(), credential = credentialGeneration, mutation = mutationGeneration, request = ++requestGeneration
    syncing.value = true
    try {
      const cloud = await gist.pullEntries()
      if (!cloud || !canSync() || consent !== getLegacySyncGeneration() || credential !== credentialGeneration
        || mutation !== mutationGeneration || request !== requestGeneration) return false
      const map = new Map(clone(entries.value).map(entry => [idOf(entry), entry]))
      for (const entry of cloud) {
        const id = idOf(entry), local = map.get(id)
        if (!local || entry.updated_at > local.updated_at) map.set(id, { ...entry, id, local_pending: true })
      }
      commit([...map.values()])
      gist.confirmEntriesApplied()
      lastSync.value = gist.getSyncTime()
      return true
    } catch { return false }
    finally { if (request === requestGeneration) syncing.value = false }
  }
  async function push(): Promise<boolean> {
    if (!canSync() || syncing.value || localStorageError.value) return false
    try { assertStorageBaseline() } catch { return false }
    const consent = getLegacySyncGeneration(), credential = credentialGeneration, mutation = mutationGeneration, request = ++requestGeneration
    // local_pending is never a cloud revision and must not cross the transport.
    const snapshot = entries.value.map(({ local_pending: _local, ...entry }) => ({ ...entry }))
    syncing.value = true
    try {
      const success = await gist.pushEntries(snapshot)
      if (!success || !canSync() || consent !== getLegacySyncGeneration() || credential !== credentialGeneration
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
    if (loaded.value && !force) return
    // No confirmed revision exists yet: pruning unsynced tombstones could let an
    // old cloud copy resurrect deleted account rows when sync is enabled later.
    if (canSync()) await pull()
    loaded.value = true
  }
  function has(code: string, account?: string) {
    return entries.value.some(entry => !entry.deleted && (account !== undefined ? idOf(entry) === entryId(code, account) : entry.code === code))
  }

  function saveHolding(input: HoldingInput, source?: EntrySnapshot, options: { confirmed?: boolean } = {}) {
    const value = validateHolding(input), id = entryId(value.code, value.account)
    const next = clone(entries.value)
    const previous = source ? next.find(entry => idOf(entry) === source.id && !entry.deleted) : undefined
    if (source) {
      assertExpected([source])
      if (!previous || previous.code !== value.code) throw new WatchMutationError('conflict')
      if (positionKind(previous) === 'holding' && value.position_kind === 'watch' && !options.confirmed) throw new WatchMutationError('requires-confirmation')
    }
    if (next.some(entry => !entry.deleted && idOf(entry) === id && idOf(entry) !== source?.id)) throw new WatchMutationError('conflict')
    const timestamp = nowISO()
    if (previous && idOf(previous) !== id) { previous.deleted = true; previous.updated_at = timestamp; previous.local_pending = true }
    const replacement: LocalWatchEntry = { ...value, id, deleted: false, updated_at: timestamp, local_pending: true }
    const index = next.findIndex(entry => idOf(entry) === id)
    if (index >= 0) next[index] = replacement
    else next.push(replacement)
    commit(next)
    schedulePush()
  }
  function add(code: string, name?: string) {
    if (has(code, '')) return
    // Explicitly re-adding a fund creates a watch record, never resurrects the
    // old tombstone's financial fields.
    saveHolding({ code, name, account: '', position_kind: 'watch', shares: null, cost: null, target_weight: null })
  }
  function remove(code: string, account?: string, options: { confirmed?: boolean; expected?: EntrySnapshot[] } = {}) {
    if (!/^\d{6}$/.test(code)) throw new WatchMutationError('invalid')
    const targets = recordsFor(code).filter(entry => account === undefined || idOf(entry) === entryId(code, account))
    if (options.expected) {
      assertExpected(options.expected)
      if (options.expected.length !== targets.length || targets.some(entry => !options.expected?.some(row => row.id === idOf(entry)))) throw new WatchMutationError('conflict')
    }
    if (!options.confirmed && (targets.length > 1 || targets.some(entry => positionKind(entry) === 'holding'))) throw new WatchMutationError('requires-confirmation')
    if (!targets.length) return
    const ids = new Set(targets.map(idOf)), timestamp = nowISO()
    commit(clone(entries.value).map(entry => ids.has(idOf(entry)) ? { ...entry, deleted: true, updated_at: timestamp, local_pending: true as const } : entry))
    schedulePush()
  }
  const toggle = (code: string, name?: string) => has(code) ? remove(code) : add(code, name)
  function setHolding(code: string, shares: number, cost: number | null, name?: string, account?: string, targetWeight?: number | null) {
    const id = entryId(code, account), previous = entries.value.find(entry => idOf(entry) === id && !entry.deleted)
    saveHolding({ code, name: name ?? previous?.name, account: account ?? '', position_kind: 'holding', shares, cost,
      target_weight: targetWeight === undefined ? previous?.target_weight ?? null : targetWeight }, previous ? { id, snapshot: JSON.stringify(previous) } : undefined)
  }
  function holdingsFor(code: string): WatchEntry[] {
    return recordsFor(code).filter(entry => positionKind(entry) === 'holding' && entry.shares != null && entry.shares > 0)
  }
  const accounts = computed(() => [...new Set(entries.value.filter(entry => !entry.deleted && entry.account?.trim()).map(entry => entry.account!.trim()))])
  const activeHoldings = computed(() => entries.value.filter(entry => !entry.deleted))
  function setToken(token: string) {
    setLegacySyncConsent(false); cancelPush(); credentialGeneration++; requestGeneration++; syncing.value = false
    gist.setToken(token.trim()); hasToken.value = gist.hasConfig()
  }
  function setLegacySyncEnabled(enabled: boolean) { setLegacySyncConsent(enabled) }
  function clearCloud() {
    setLegacySyncConsent(false); cancelPush(); credentialGeneration++; requestGeneration++; syncing.value = false
    gist.clearConfig(); hasToken.value = false; lastSync.value = ''
  }
  return {
    items, entries, activeHoldings, accounts, loaded, syncing, lastSync, hasToken, legacySyncEnabled, localStorageError, localStatus,
    load, has, add, remove, toggle, setHolding, holdingsFor, recordsFor, saveHolding, entrySnapshot, hasLocalChanges, localPending,
    readOwnerSyncSnapshot, assertOwnerSyncSnapshot,
    setToken, setLegacySyncEnabled, manualUpload: push, manualDownload: pull, clearCloud, push, pull,
  }
})
