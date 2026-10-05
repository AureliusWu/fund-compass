import { defineStore } from 'pinia'
import { ref, computed, onScopeDispose } from 'vue'
import * as gist from '@/utils/gist'
import type { WatchEntry } from '@/utils/gist'
import { entryId, migrateEntries } from '@/utils/gist'
import { getLegacySyncConsent, setLegacySyncConsent, getLegacySyncGeneration, subscribeLegacySyncConsent } from '@/utils/cloud-consent'
import { positionKind, validateHolding, WatchMutationError, type HoldingInput, type EntrySnapshot } from '@/utils/holding-editor'

const LS = 'sinan_watchlist_v2'
const PUSH_DELAY = 4000
const nowISO = () => new Date().toISOString()
type LocalWatchEntry = WatchEntry & { local_pending?: true }
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

function loadLS(): { rows: LocalWatchEntry[]; error: boolean; raw: string | null } {
  let raw: string | null = null
  try {
    // The baseline is the original v2 value, not the v1 fallback or normalized
    // rows. A first successful v1 migration therefore compares against null.
    raw = localStorage.getItem(LS)
    return { ...parseStored(raw ?? localStorage.getItem('sinan_watchlist_v1') ?? '[]'), raw }
  } catch { return { rows: [], error: true, raw } }
}

export const useWatchlistStore = defineStore('watchlist', () => {
  const initial = loadLS()
  const entries = ref<LocalWatchEntry[]>(initial.rows)
  const localStorageError = ref(initial.error)
  const externalUnconfirmed = ref(false)
  let storageBaseline = initial.raw
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
    let current: string | null
    try { current = localStorage.getItem(LS) }
    catch {
      localStorageError.value = true
      invalidateExternalState()
      throw new WatchMutationError('storage')
    }
    if (current !== storageBaseline) {
      invalidateExternalState()
      throw new WatchMutationError('conflict')
    }
  }
  function storageChanged(event: StorageEvent) {
    if (event.key !== LS && event.key !== null) return
    let raw: string | null
    try {
      if (event.storageArea && event.storageArea !== localStorage) return
      // Read the currently observed disk value, not a possibly queued old event.
      raw = localStorage.getItem(LS)
    } catch {
      localStorageError.value = true
      invalidateExternalState()
      return
    }
    if (raw === storageBaseline && !localStorageError.value) return
    invalidateExternalState()
    const parsed = parseStored(raw ?? '[]')
    if (parsed.error) {
      // Keep both the malformed disk data and the previous working copy.
      localStorageError.value = true
      return
    }
    entries.value = parsed.rows
    storageBaseline = raw
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
    assertStorageBaseline()
    const serialized = JSON.stringify(next)
    // This observed-raw guard is not an atomic cross-tab transaction or Owner
    // revision. Native getItem + setItem cannot provide that stronger guarantee.
    try { localStorage.setItem(LS, serialized) }
    catch {
      localStorageError.value = true
      invalidateExternalState()
      throw new WatchMutationError('storage')
    }
    storageBaseline = serialized
    entries.value = next
    mutationGeneration++
  }
  function entrySnapshot(id: string): string | null {
    const entry = entries.value.find(row => idOf(row) === id && !row.deleted)
    return entry ? JSON.stringify(entry) : null
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
    setToken, setLegacySyncEnabled, manualUpload: push, manualDownload: pull, clearCloud, push, pull,
  }
})
