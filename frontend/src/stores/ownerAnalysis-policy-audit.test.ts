/** Independent actual Store/manager/IDB policy-clock audit; only HTTP is fake.
 * Advancing timer/monotonic time independently from Date.now models a stopped
 * wall clock, not an elapsed wall-clock renewal or a browser/deployment test.
 */
import { webcrypto } from 'node:crypto'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory } from 'fake-indexeddb'
import { useOwnerAnalysisStore } from './ownerAnalysis'
import { useWatchlistStore } from './watchlist'
import { clearOwnerSession, loginOwnerSession } from './ownerSession'
import { openOwnerAuthority } from './owner-authority'
import { openOwnerWorkspace, upgradeOwnerWorkspaceSync, buildOwnerWorkspaceLinkCloudRequest,
  type OwnerWorkspace } from './owner-workspace'
import { openOwnerAnalysisOutbox, type OwnerAnalysisOutbox } from './owner-analysis-outbox'
import { ownerAnalysisBackendFixture } from '@/utils/ownerAnalysisContract.fixtures'
import { setLegacySyncConsent } from '@/utils/cloud-consent'
import type { OwnerSyncRecord } from '@/utils/ownerSyncContract'

const mocks = vi.hoisted(() => ({ analysis: vi.fn(), sync: vi.fn(), write: vi.fn(), receipt: vi.fn(),
  policy: vi.fn(), policyState: vi.fn(), evidence: vi.fn(), changes: vi.fn(), fetch: vi.fn() }))
vi.mock('@/api/owner-analysis-transport', () => ({ createOwnerAnalysisHttpTransport: mocks.analysis }))
vi.mock('@/api/owner-sync-transport', () => ({ createOwnerSyncHttpTransport: mocks.sync }))

const NOW = Date.parse('2026-10-24T00:00:00Z'), TOKEN = 'own_' + 'q'.repeat(43)
const fixture = ownerAnalysisBackendFixture()
const records: OwnerSyncRecord[] = [{ key: '510300::synthetic-account', kind: 'holding', deleted: false,
  record_revision: 1, lifecycle_revision: 1, field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
  values: { name: 'synthetic private analysis fund', shares: 10, cost: 1, target_weight: 20 } }]
let wall: number, monotonic: number, factory: IDBFactory, target: string
let analysis: ReturnType<typeof useOwnerAnalysisStore>
const stores: Array<{ $dispose(): void }> = [], handles: Array<OwnerWorkspace | OwnerAnalysisOutbox> = []

async function taskImage() {
  const outbox = await openOwnerAnalysisOutbox(factory, target, new AbortController().signal, false)
  handles.push(outbox)
  return outbox.read(new AbortController().signal)
}

beforeEach(async () => {
  clearOwnerSession()
  wall = NOW; monotonic = 100
  // Keep IDB's setImmediate scheduling native. Only UI/deadline timers are fake.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.spyOn(Date, 'now').mockImplementation(() => wall)
  vi.spyOn(globalThis.performance, 'now').mockImplementation(() => monotonic)
  vi.stubGlobal('crypto', webcrypto); factory = new IDBFactory(); target = ''
  vi.stubGlobal('indexedDB', factory); vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('location', { origin: 'https://policy-clock-audit.example' })
  const data = new Map([['sinan_watchlist_v2', JSON.stringify([{ code: '510300', account: 'synthetic-account',
    name: 'synthetic private analysis fund', position_kind: 'holding', shares: 10, cost: 1, target_weight: 20,
    updated_at: '2026-10-23T00:00:00Z' }])]])
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) })
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' })
  setLegacySyncConsent(false)
  for (const mock of Object.values(mocks)) mock.mockReset()
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ access_token: TOKEN, token_type: 'Bearer', owner_id: 'owner',
    expires_at: new Date(NOW + 1_800_000).toISOString(), scopes: ['read_private', 'write_holdings', 'run_personal_analysis'] }),
  { headers: { 'Content-Type': 'application/json' } }))
  mocks.write.mockResolvedValue({ status: 200, rawBody: fixture.response })
  mocks.receipt.mockResolvedValue({ status: 200, rawBody: JSON.stringify({ state: 'matched', status: 200, result: JSON.parse(fixture.response) }) })
  mocks.policy.mockResolvedValue({ status: 200, rawBody: fixture.policy })
  mocks.policyState.mockImplementation(async () => ({ status: 200, rawBody: JSON.stringify({
    schema_version: 'owner-policy-state-1', observed_at: new Date(wall - 1).toISOString(),
    current: JSON.parse(fixture.policy), history: [JSON.parse(fixture.policy)], next_effective_at: null,
  }) }))
  mocks.evidence.mockResolvedValue({ status: 200, rawBody: fixture.evidence })
  mocks.changes.mockResolvedValue({ status: 200, rawBody: JSON.stringify({ upper_revision: 1,
    changes: records, next_cursor: null, complete: true }) })
  mocks.analysis.mockImplementation(async () => ({ targetFingerprint: target, write: mocks.write, receipt: mocks.receipt,
    policy: mocks.policy, policyState: mocks.policyState, evidence: mocks.evidence }))
  mocks.sync.mockImplementation(async () => ({ targetFingerprint: target, changes: mocks.changes,
    write: vi.fn(async () => { throw new Error('audit must not write sync') }), receipt: vi.fn() }))
  setActivePinia(createPinia())
  const first = useWatchlistStore(); stores.push(first); await first.initialize()
  const backup = await first.createLocalWorkspaceBackup()
  await first.activateLocalWorkspace(backup.raw, backup.sha256)
  const locator = await openOwnerAuthority(factory, localStorage), pointer = await locator.read(); locator.close()
  target = pointer.targetFingerprint!
  const guard = { signal: new AbortController().signal, assertActive() {} }
  const old = await openOwnerWorkspace(factory, target, { existingOnly: true }); handles.push(old)
  const v4 = await upgradeOwnerWorkspaceSync(factory, target, await old.readLocalState(guard), guard); handles.push(v4)
  await v4.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(target, { id: 'policy-clock-audit-link-0001',
    expected: await v4.readSyncState(guard), base: { pulledRevision: 1, records } }), guard)
  first.$dispose()
  setActivePinia(createPinia())
  const workspace = useWatchlistStore(); stores.push(workspace)
  await workspace.initialize(); await workspace.load(true)
  analysis = useOwnerAnalysisStore(); stores.push(analysis)
  await loginOwnerSession('synthetic-policy-clock-audit-password')
  await analysis.enable(true)
})

afterEach(() => {
  stores.splice(0).reverse().forEach(store => store.$dispose())
  handles.splice(0).forEach(handle => handle.close()); clearOwnerSession()
  vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
})

async function prepared() {
  await analysis.preview(fixture.request.request_id)
  await analysis.prepare(true)
}

describe('independent actual Store policy freshness audit', () => {
  it('invalidates cached action qualification when monotonic/timer time expires but Date.now stops', async () => {
    await prepared(); await analysis.sendOnce(true)
    // Force Vue to cache both the qualification and its displayed results.
    expect(analysis.qualified).toBe(true); expect(analysis.results).toHaveLength(1)
    const original = await taskImage()
    monotonic += 60_000
    await vi.advanceTimersByTimeAsync(60_000); await nextTick()
    expect(analysis.qualified).toBe(false)
    expect(analysis.results).toEqual([])
    expect(await taskImage()).toEqual(original)
    expect(mocks.write).toHaveBeenCalledOnce()
  })

  it('does not treat a stopped-wall-clock prepared Policy preview as fresh after one elapsed minute', async () => {
    await prepared()
    const original = await taskImage()
    expect(analysis.previewFresh).toBe(true)
    monotonic += 60_000
    await vi.advanceTimersByTimeAsync(60_000); await nextTick()
    expect(analysis.previewFresh).toBe(false)
    await expect(analysis.sendOnce(true)).rejects.toBeDefined()
    expect(await taskImage()).toEqual(original)
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('rejects a direct send after the preview monotonic window even while Date.now stays unchanged', async () => {
    await prepared()
    const original = await taskImage()
    monotonic += 60_000
    await vi.advanceTimersByTimeAsync(60_000)
    await expect(analysis.sendOnce(true)).rejects.toBeDefined()
    expect(await taskImage()).toEqual(original)
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('rechecks Policy expiry after actual attempted CAS before POST without reverting the marker', async () => {
    await prepared()
    const original = await taskImage(), transaction = IDBDatabase.prototype.transaction
    // The observation is NOW-1ms, so NOW+59998 is its last fresh millisecond.
    wall = NOW + 59_998; monotonic += 59_998
    let crossed = false
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.apply(this, args)
      if (this.name.startsWith('fund-compass-owner-analysis-1:') && args[1] === 'readwrite') {
        tx.addEventListener('complete', () => {
          crossed = true; wall = NOW + 60_000; monotonic = 60_100
        }, { once: true })
      }
      return tx
    })
    await expect(analysis.sendOnce(true)).rejects.toBeDefined()
    expect(crossed).toBe(true)
    expect(mocks.write).not.toHaveBeenCalled()
    const actual = await taskImage()
    expect(actual.task?.state).toBe('attempted')
    expect(actual.task?.rawBody).toBe(original.task?.rawBody)
    expect(actual.task?.requestHash).toBe(original.task?.requestHash)
    await expect(analysis.sendOnce(true)).rejects.toBeDefined()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('does not restart the Policy proof window after Evidence work while the wall clock stops', async () => {
    await prepared()
    // The qualification phase has already read its Policy, then this real
    // awaited Evidence boundary consumes 10 seconds of its original proof.
    mocks.evidence.mockImplementationOnce(async () => {
      monotonic += 10_000
      return { status: 200, rawBody: fixture.evidence }
    })
    await analysis.sendOnce(true)
    expect(analysis.qualified).toBe(true); expect(analysis.results).toHaveLength(1)
    const original = await taskImage()
    monotonic += 50_000
    await vi.advanceTimersByTimeAsync(50_000); await nextTick()
    expect(analysis.policyStateFresh).toBe(false)
    expect(analysis.qualified).toBe(false)
    expect(analysis.results).toEqual([])
    expect(await taskImage()).toEqual(original)
    expect(mocks.write).toHaveBeenCalledOnce()
  })

  it('Policy-only review never renews an existing analysis or changes an attempted original task', async () => {
    await prepared()
    mocks.write.mockRejectedValueOnce(new Error('synthetic accepted response lost'))
    await expect(analysis.sendOnce(true)).rejects.toBeDefined()
    const original = await taskImage(), pulls = mocks.changes.mock.calls.length
    expect(original.task?.state).toBe('attempted')
    await analysis.reviewPolicy()
    expect(analysis.qualified).toBe(false); expect(analysis.results).toEqual([])
    expect(await taskImage()).toEqual(original)
    await expect(analysis.sendOnce(true)).rejects.toBeDefined()
    expect(await taskImage()).toEqual(original)
    expect(mocks.changes).toHaveBeenCalledTimes(pulls)
    expect(mocks.write).toHaveBeenCalledOnce(); expect(mocks.receipt).not.toHaveBeenCalled()
  })
})
