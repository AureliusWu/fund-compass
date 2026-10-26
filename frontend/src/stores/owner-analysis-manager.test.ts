/** Real task/workspace IDB and raw contracts; only HTTP is synthetic. */
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory } from 'fake-indexeddb'
import { createOwnerAnalysisManager, type OwnerAnalysisManager } from './owner-analysis-manager'
import { openOwnerAnalysisOutbox, type OwnerAnalysisOutbox } from './owner-analysis-outbox'
import { openOwnerWorkspace, upgradeOwnerWorkspaceSync, upgradeOwnerWorkspacePortfolio, upgradeOwnerWorkspaceFullSync,
  buildOwnerWorkspacePortfolioUpgradeBackup, buildOwnerWorkspacePortfolioUpgradeRequest,
  buildOwnerWorkspaceFullSyncUpgradeRequest, buildOwnerWorkspaceFullSyncLinkRequest,
  buildOwnerWorkspaceFullSyncRefreshRequest, buildOwnerWorkspaceEditPortfolioRequest, buildOwnerWorkspaceAdoptLocalRequest,
  buildOwnerWorkspaceLinkCloudRequest, buildOwnerWorkspaceEditLocalRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard } from './owner-workspace'
import type { OwnerAnalysisLocalSource } from './watchlist'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { planOwnerWorkspaceCloudIntent } from '@/utils/owner-workspace-sync'
import { planOwnerPortfolioCloudIntent } from '@/utils/owner-portfolio-sync'
import { buildOwnerPortfolioRecoveryBackup } from '@/utils/owner-portfolio-recovery'
import { compareSyncKeys, parseSyncChangesPage, OWNER_SYNC_MAX_RESPONSE_BYTES, type OwnerSyncRecord } from '@/utils/ownerSyncContract'
import { ownerAnalysisBackendFixture } from '@/utils/ownerAnalysisContract.fixtures'
import { ownerAnalysisV6BackendFixture } from '@/utils/owner-analysis-v6-contract.fixtures'
import { ownerAdminPolicyLifecycleBackendFixture } from '@/utils/owner-admin-policy-lifecycle.fixtures'
import type { BuiltOwnerAnalysisRequest } from '@/utils/ownerAnalysisContract'
import type { OwnerSyncCandidateTransport } from './ownerSyncCandidate'

const TARGET = 'e'.repeat(64), KEY = '510300::synthetic-account', NOW = Date.parse('2026-10-24T00:00:00Z')
const handles: Array<OwnerWorkspace | OwnerAnalysisOutbox> = [], managers: OwnerAnalysisManager[] = []
const signal = () => new AbortController().signal
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  const forbidden = () => { throw new Error('ambient IO forbidden') }
  vi.stubGlobal('fetch', forbidden); vi.stubGlobal('indexedDB', { open: forbidden })
  vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden })
})
afterEach(() => {
  managers.splice(0).forEach(manager => manager.close()); handles.splice(0).forEach(handle => handle.close())
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function records(extra: boolean): OwnerSyncRecord[] {
  const fund: OwnerSyncRecord = { key: KEY, kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
      field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
      values: { name: 'synthetic private analysis fund', shares: 10, cost: 1, target_weight: 20 } }
  const manual: OwnerSyncRecord = { key: 'asset:synthetic-cash', kind: 'manual_asset', deleted: false,
    record_revision: 1, lifecycle_revision: 1, field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
    values: { name: '合成现金', cls: '现金', value: 0, note: null } }
  const tombstone: OwnerSyncRecord = { key: '000009::deleted', kind: 'watch', deleted: true,
    record_revision: 1, lifecycle_revision: 1, field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: '合成墓碑', shares: null, cost: null, target_weight: null } }
  return [fund, ...(extra ? [manual, tombstone] : [])].sort((a, b) => compareSyncKeys(a.key, b.key))
}
async function setup(extra = false, additionalManuals = 0, sourceRevision = 1, profile: 'v4' | 'v6' = 'v4') {
  const fixture = ownerAnalysisBackendFixture(), factory = new IDBFactory(), mutable = {
    endpoint: 'https://synthetic-owner.example/api', generation: 1, authenticated: true, sourceEpoch: 0, now: NOW, cloudRevision: sourceRevision,
    cloud: [...records(extra), ...Array.from({ length: additionalManuals }, (_, index): OwnerSyncRecord => ({
      key: 'asset:extra-' + String(index).padStart(3, '0'), kind: 'manual_asset', deleted: false,
      record_revision: 1, lifecycle_revision: 1, field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
      values: { name: '合成手工资产', cls: '现金', value: 0, note: null },
    }))].map(row => ({ ...row, record_revision: sourceRevision,
      field_revisions: Object.fromEntries(Object.keys(row.field_revisions).map(field => [field, sourceRevision])) }))
      .sort((a, b) => compareSyncKeys(a.key, b.key)),
  }
  const guard: OwnerWorkspaceGuard = { signal: signal(), assertActive() {} }
  const legacy = await openOwnerWorkspace(factory, TARGET); handles.push(legacy)
  const sourceArchive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: null,
    v2Raw: JSON.stringify([{ code: '510300', name: 'synthetic private analysis fund', account: 'synthetic-account',
      position_kind: 'holding', shares: 10, cost: 1, target_weight: 20, updated_at: '2026-10-23T00:00:00Z' }]) }
  const backup = await buildOwnerLegacyWorkspaceBackup(sourceArchive)
  const adoption = await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'analysis-adopt-0001',
    expected: await legacy.readLocalState(guard), sourceArchive, backupSha256: backup.sha256 })
  const local = await legacy.adoptLocal(adoption, guard)
  let workspace = await upgradeOwnerWorkspaceSync(factory, TARGET, local, guard); handles.push(workspace)
  await workspace.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'analysis-link-0001',
    expected: await workspace.readSyncState(guard), base: { pulledRevision: sourceRevision, records: mutable.cloud } }), guard)
  async function upgradeFull() {
    const portfolioFile = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, await workspace.readLocalState(guard), {
      manualRaw: canonicalOwnerLocal(mutable.cloud.filter(row => row.kind === 'manual_asset').map(row => ({
        id: row.key.slice('asset:'.length), name: row.values.name, cls: row.values.cls, value: row.values.value,
        updated_at: '2026-10-23T00:00:00Z',
      }))), snapshotsRaw: canonicalOwnerLocal([{ date: '2026-10-23', value: 0, cost: 0 }]),
    })
    workspace = await upgradeOwnerWorkspacePortfolio(factory, TARGET, await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET, {
      id: 'analysis-portfolio-upgrade-0001', backupRaw: portfolioFile.raw, backupSha256: portfolioFile.sha256,
    }), guard); handles.push(workspace)
    const fullFile = await buildOwnerPortfolioRecoveryBackup(TARGET, await workspace.readLocalState(guard))
    workspace = await upgradeOwnerWorkspaceFullSync(factory, TARGET, await buildOwnerWorkspaceFullSyncUpgradeRequest(TARGET, {
      id: 'analysis-full-upgrade-0001', backupRaw: fullFile.raw, backupSha256: fullFile.sha256,
    }), guard); handles.push(workspace)
    await workspace.linkFullSyncBase(await buildOwnerWorkspaceFullSyncLinkRequest(TARGET, {
      id: 'analysis-full-link-0001', expected: await workspace.readFullSyncState(guard),
      base: { pulledRevision: sourceRevision, records: mutable.cloud }, minimumObservedRevision: sourceRevision, resolutions: [],
    }), guard)
    profile = 'v6'; mutable.sourceEpoch++
  }
  if (profile === 'v6') await upgradeFull()
  const outbox = await openOwnerAnalysisOutbox(factory, TARGET, signal(), true); handles.push(outbox)
  const source = vi.fn(async (active: AbortSignal): Promise<OwnerAnalysisLocalSource> => {
    const epoch = mutable.sourceEpoch
    const assertActive = () => { if (epoch !== mutable.sourceEpoch) throw new Error('real source epoch changed') }
    const actualGuard = { signal: active, assertActive }
    const read = async (selected: OwnerWorkspaceGuard) => profile === 'v6'
      ? { profile: 'v6' as const, state: await workspace.readFullSyncState(selected) }
      : { profile: 'v4' as const, state: await workspace.readSyncState(selected) }
    const captured = await read(actualGuard), { state } = captured
    const metadata = captured.profile === 'v6' ? captured.state.fullSync : captured.state.sync
    if (active.aborted || state.local.outbox.entry || metadata.pending || !metadata.base) throw new Error('source not ready')
    const intent = captured.profile === 'v6'
      ? planOwnerPortfolioCloudIntent(metadata.base, state.local.snapshot, state.local.portfolio!)
      : planOwnerWorkspaceCloudIntent(metadata.base, state.local.snapshot)
    if (intent.issues.length || intent.operations.length) throw new Error('actual B to L is not unchanged')
    const image = (value: typeof captured) => canonicalOwnerLocal(value.profile === 'v4' ? value.state : value)
    const preimage = image(captured)
    return Object.freeze({ ...captured, targetFingerprint: TARGET, preimage, assertActive,
      async verify(stopped: AbortSignal) {
        assertActive()
        const current = await read({ signal: stopped, assertActive })
        if (stopped.aborted || image(current) !== preimage) throw new Error('actual full IDB preimage changed')
      },
    })
  })
  const transport = {
    targetFingerprint: TARGET,
    write: vi.fn(async (_packet: BuiltOwnerAnalysisRequest, _signal: AbortSignal) => ({ status: 200, rawBody: fixture.response })),
    receipt: vi.fn(async (_packet: BuiltOwnerAnalysisRequest, _signal: AbortSignal) => ({ status: 200, rawBody: JSON.stringify({ state: 'matched', status: 200, result: JSON.parse(fixture.response) }) })),
    policy: vi.fn(async (_signal: AbortSignal) => ({ status: 200, rawBody: fixture.policy })),
    policyState: vi.fn(async (_signal: AbortSignal) => ({ status: 200, rawBody: JSON.stringify({
      schema_version: 'owner-policy-state-1', observed_at: new Date(mutable.now).toISOString(),
      current: JSON.parse(fixture.policy), history: [JSON.parse(fixture.policy)], next_effective_at: null,
    }) })),
    evidence: vi.fn(async (_code: string, _signal: AbortSignal) => ({ status: 200, rawBody: fixture.evidence })),
  }
  const sync = { targetFingerprint: TARGET,
    write: vi.fn(async () => { throw new Error('analysis must not write Owner sync') }),
    receipt: vi.fn(async () => { throw new Error('analysis must not read a sync write receipt') }),
    changes: vi.fn(async (_parameters: Parameters<OwnerSyncCandidateTransport['changes']>[0], _signal: AbortSignal) => ({ status: 200, rawBody: JSON.stringify({ upper_revision: mutable.cloudRevision,
      changes: mutable.cloud, next_cursor: null, complete: true }) })),
  }
  const changed = vi.fn()
  function manager(selected = outbox) {
    const value = createOwnerAnalysisManager({ outbox: selected, source, transport, sync,
      session: () => ({ authenticated: mutable.authenticated, generation: mutable.generation }),
      endpoint: () => mutable.endpoint, changed, now: () => mutable.now })
    managers.push(value); return value
  }
  const value = manager()
  const edit = async () => {
    const expected = await workspace.readLocalState(guard), previous = expected.snapshot.entries.find(row => row.key === KEY)!
    await workspace.editLocal(await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'analysis-source-edit-0001', expected,
      command: { type: 'save', input: { code: '510300', name: previous.values.name, account: 'synthetic-account',
        position_kind: 'holding', shares: 11, cost: previous.values.cost, target_weight: previous.values.target_weight },
      expectedEntry: previous, confirmed: true } }), guard)
    mutable.sourceEpoch++
  }
  return { fixture, factory, workspace, outbox, mutable, source, transport, sync, manager, value, edit, upgradeFull,
    activeWorkspace: () => workspace }
}
type Setup = Awaited<ReturnType<typeof setup>>
function historyPage(rows: OwnerSyncRecord[], upper: number, complete = true, paddedBytes?: number) {
  const tail = rows[rows.length - 1]
  const raw = JSON.stringify({ upper_revision: upper, changes: rows,
    next_cursor: complete ? null : [tail.record_revision, tail.key], complete })
  const bytes = new TextEncoder().encode(raw).byteLength
  if (paddedBytes !== undefined) expect(bytes).toBeLessThanOrEqual(paddedBytes)
  return { status: 200, rawBody: raw + ' '.repeat(paddedBytes === undefined ? 0 : paddedBytes - bytes) }
}
function historicalRows(rows: OwnerSyncRecord[], revision: number) {
  return rows.map(row => ({ ...row, record_revision: revision,
    field_revisions: Object.fromEntries(Object.keys(row.field_revisions).map(field => [field, revision])) }))
}
async function prepared(context: Setup) {
  await context.value.hydrate(); await context.value.preview(context.fixture.request.request_id); await context.value.prepare(true)
}
function scheduledPolicy(context: Setup, delay = 20_000) {
  const original = JSON.parse(context.fixture.policy)
  const future = { ...original, policy_version: 'pol_' + 'd'.repeat(64), supersedes: original.policy_version,
    name: 'Synthetic scheduled successor', created_at: new Date(NOW - 1000).toISOString(),
    effective_at: new Date(NOW + delay).toISOString() }
  context.transport.policyState.mockImplementation(async () => ({ status: 200, rawBody: JSON.stringify({
    schema_version: 'owner-policy-state-1', observed_at: new Date(context.mutable.now).toISOString(),
    current: context.mutable.now < NOW + delay ? original : future,
    next_effective_at: context.mutable.now < NOW + delay ? future.effective_at : null, history: [future, original],
  }) }))
  return future
}

/** The server fixture is independently rebuilt from actual SQLite transactions.
 * No source SHA, Python model ID or financial result is reconstructed here. */
async function actualFullAnalysis() {
  const backend = ownerAnalysisV6BackendFixture(), context = await setup(false, 0, 1, 'v6')
  const handle = context.activeWorkspace(), guard = { signal: signal(), assertActive() {} }
  context.mutable.cloud = [...backend.currentRecords]; context.mutable.cloudRevision = 3
  context.mutable.now = Date.parse(backend.now)
  const before = await handle.readFullSyncState(guard)
  await handle.refreshFullSync(await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, {
    id: 'analysis-full-backend-refresh-0001', expected: before,
    completeBaseline: { pulledRevision: 3, records: backend.currentRecords }, minimumObservedRevision: 3, resolutions: [],
  }), guard)
  context.transport.policyState.mockImplementation(async () => ({ status: 200, rawBody: JSON.stringify({
    schema_version: 'owner-policy-state-1', observed_at: backend.now,
    current: JSON.parse(backend.policy), history: [JSON.parse(backend.policy)], next_effective_at: null,
  }) }))
  context.transport.evidence.mockResolvedValue({ status: 200, rawBody: backend.evidence })
  context.transport.write.mockResolvedValue({ status: 200, rawBody: backend.response })
  context.transport.receipt.mockResolvedValue({ status: 200, rawBody: JSON.stringify({
    state: 'matched', status: 200, result: JSON.parse(backend.response),
  }) })
  context.sync.changes.mockResolvedValue({ status: 200, rawBody: backend.currentChangesRaw })
  return { context, backend, handle, guard, before }
}

const setupProfile = setup
describe.each(['v4', 'v6'] as const)('real source-bound Owner analysis manager (%s)', profile => {
  const setup = (extra = false, additionalManuals = 0, sourceRevision = 1) => setupProfile(extra, additionalManuals, sourceRevision, profile)
  it('constructs with no task reads, source reads, quote, sync or analysis HTTP', async () => {
    const context = await setup()
    const read = vi.fn(context.outbox.read)
    context.manager({ ...context.outbox, read })
    expect(read).not.toHaveBeenCalled(); expect(context.source).not.toHaveBeenCalled()
    for (const call of [context.transport.write, context.transport.receipt, context.transport.policy, context.transport.policyState,
      context.transport.evidence, context.sync.changes]) expect(call).not.toHaveBeenCalled()
  })

  it('requires separate prepare and send confirmation, persists attempted before the only POST, and qualifies the actual run', async () => {
    const context = await setup()
    await context.value.hydrate(); await context.value.preview(context.fixture.request.request_id)
    expect((await context.outbox.read(signal())).task).toBeNull()
    expect(context.transport.write).not.toHaveBeenCalled()
    await expect(context.value.prepare(false as true)).rejects.toBeDefined()
    await context.value.prepare(true)
    expect((await context.outbox.read(signal())).task?.state).toBe('prepared')
    context.transport.write.mockImplementationOnce(async () => {
      expect((await context.outbox.read(signal())).task?.state).toBe('attempted')
      return { status: 200, rawBody: context.fixture.response }
    })
    await context.value.sendOnce(true)
    expect((await context.outbox.read(signal())).task?.state).toBe('matched')
    expect(context.value.view().result?.run.request_hash).toBe(context.fixture.requestHash)
    expect(context.value.isQualified()).toBe(true)
    await expect(context.value.sendOnce(true)).rejects.toBeDefined()
    expect(context.transport.write).toHaveBeenCalledOnce()
    expect(context.sync.write).not.toHaveBeenCalled()
  })

  it.each(['throw', 'unknown'] as const)('retains the original attempted task on %s, never resends, and reconciles only by original receipt', async fault => {
    const context = await setup(); await prepared(context)
    if (fault === 'throw') context.transport.write.mockRejectedValueOnce(new Error('synthetic accepted response lost'))
    else context.transport.write.mockResolvedValueOnce({ status: 503, rawBody: '{"detail":"analysis_result_unknown"}' })
    await expect(context.value.sendOnce(true)).rejects.toBeDefined()
    const actual = await context.outbox.read(signal())
    expect(actual.task).toMatchObject({ state: 'attempted', rawBody: context.fixture.rawBody, requestHash: context.fixture.requestHash })
    expect(context.value.view().result).toBeNull(); expect(context.value.isQualified()).toBe(false)
    await expect(context.value.sendOnce(true)).rejects.toBeDefined()
    await expect(context.value.cancelPrepared(true)).rejects.toBeDefined()
    expect(context.transport.write).toHaveBeenCalledOnce(); expect(context.transport.receipt).not.toHaveBeenCalled()
    await context.value.reconcile()
    expect(context.transport.receipt).toHaveBeenCalledOnce()
    expect(context.value.isQualified()).toBe(true)
    expect(context.transport.receipt.mock.calls[0][0]).toMatchObject({ rawBody: context.fixture.rawBody, requestHash: context.fixture.requestHash })
  })

  it('allows only one POST when two real handles compete for the same prepared marker', async () => {
    const context = await setup(); await prepared(context)
    const otherOutbox = await openOwnerAnalysisOutbox(context.factory, TARGET, signal(), false); handles.push(otherOutbox)
    const other = context.manager(otherOutbox)
    await other.hydrate(); await other.preview('ignored-existing-original-id')
    const results = await Promise.allSettled([context.value.sendOnce(true), other.sendOnce(true)])
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(context.transport.write).toHaveBeenCalledOnce()
    expect((await context.outbox.read(signal())).task?.state).toBe('matched')
  })

  it('requires a fresh matching receipt after reloading a matched task before ending it', async () => {
    const context = await setup(); await prepared(context); await context.value.sendOnce(true); context.value.close()
    const nextOutbox = await openOwnerAnalysisOutbox(context.factory, TARGET, signal(), false); handles.push(nextOutbox)
    const reloaded = context.manager(nextOutbox)
    await reloaded.hydrate()
    expect(reloaded.view().slot?.task?.state).toBe('matched')
    expect(reloaded.view().result).toBeNull(); expect(reloaded.isQualified()).toBe(false)
    await expect(reloaded.finishMatched(true)).rejects.toBeDefined()
    await reloaded.reconcile(); expect(reloaded.isQualified()).toBe(true)
    await reloaded.finishMatched(true)
    expect((await nextOutbox.read(signal())).task).toBeNull()
    expect(context.transport.write).toHaveBeenCalledOnce()
  })

  it.each(['session', 'endpoint', 'source'] as const)('hides a late accepted result after %s changed, preserving the attempted original task', async fault => {
    const context = await setup(); await prepared(context)
    let finish!: (result: { status: number; rawBody: string }) => void
    context.transport.write.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const sending = context.value.sendOnce(true), assertion = expect(sending).rejects.toBeDefined()
    await vi.waitFor(() => expect(context.transport.write).toHaveBeenCalledOnce())
    if (fault === 'session') context.mutable.generation++
    if (fault === 'endpoint') context.mutable.endpoint = 'https://different-owner.example/api'
    if (fault === 'source') await context.edit()
    finish({ status: 200, rawBody: context.fixture.response }); await assertion
    expect(context.value.view().result).toBeNull(); expect(context.value.isQualified()).toBe(false)
    if (fault === 'endpoint' || fault === 'session') {
      expect(context.value.view().preview).toBeNull()
      expect(context.value.view().slot).toBeNull()
    }
    const task = (await context.outbox.read(signal())).task
    expect(task?.requestHash).toBe(context.fixture.requestHash)
    expect(['attempted', 'matched']).toContain(task?.state)
    expect(context.transport.write).toHaveBeenCalledOnce()
  })

  it('preserves manual zero/null and tombstones in the complete preview, without adding them as fund Evidence', async () => {
    const context = await setup(true)
    await context.value.preview(context.fixture.request.request_id)
    const preview = context.value.view().preview!
    expect(preview.records).toEqual(context.mutable.cloud)
    expect(preview.records.find(row => row.kind === 'manual_asset')?.values).toMatchObject({ value: 0, note: null })
    expect(preview.records.find(row => row.deleted)?.key).toBe('000009::deleted')
    expect(preview.packet.request.evidence.map(row => row.code)).toEqual(['510300'])
    expect(context.transport.evidence.mock.calls).toHaveLength(1)
    expect(context.transport.write).not.toHaveBeenCalled()
  })

  it('requires every fixed-upper full page before previewing references or saving a task', async () => {
    const context = await setup(true, 198), rows = context.mutable.cloud
    context.sync.changes.mockImplementation(async parameters => {
      expect(parameters.sinceRevision).toBe(0)
      if (!parameters.cursor) return { status: 200, rawBody: JSON.stringify({ upper_revision: 1,
        changes: rows.slice(0, 200), next_cursor: [1, rows[199].key], complete: false }) }
      expect(parameters.upperRevision).toBe(1); expect(parameters.cursor).toEqual([1, rows[199].key])
      return { status: 200, rawBody: JSON.stringify({ upper_revision: 1,
        changes: rows.slice(200), next_cursor: null, complete: true }) }
    })
    await context.value.preview(context.fixture.request.request_id)
    expect(context.sync.changes).toHaveBeenCalledTimes(2)
    expect(context.value.view().preview!.records).toEqual(rows)
    expect((await context.outbox.read(signal())).task).toBeNull()
    expect(context.transport.write).not.toHaveBeenCalled()
  })

  it.each(['exactly-four-MiB', 'over-four-MiB'] as const)('accounts all repeated-key raw history before using matching complete analysis inputs (%s)', async size => {
    // The actual adopted B has the same 200 final records and head as D. A
    // rejection here cannot be explained away by a B/D business mismatch.
    const context = await setup(false, 199, 10), cloud = context.mutable.cloud
    expect(cloud).toHaveLength(200)
    const revisions = size === 'exactly-four-MiB' ? [1, 10] : [1, 2, 10]
    const batches = revisions.map(revision => historicalRows(cloud, revision))
    const responses = batches.map((rows, index) => historyPage(rows, 10, index === batches.length - 1,
      size === 'exactly-four-MiB' ? OWNER_SYNC_MAX_RESPONSE_BYTES : 1536 * 1024))
    responses.forEach((response, index) => expect(parseSyncChangesPage(response.rawBody, {
      sinceRevision: 0, limit: 200, ...(index === 0 ? {} : { upperRevision: 10,
        cursor: [batches[index - 1][199].record_revision, batches[index - 1][199].key] as const }),
    }).changes).toHaveLength(200))
    for (const response of responses) context.sync.changes.mockResolvedValueOnce(response)
    if (size === 'over-four-MiB') {
      await expect(context.value.preview(context.fixture.request.request_id)).rejects.toBeDefined()
      expect(context.value.view().preview).toBeNull(); expect(context.value.isQualified()).toBe(false)
      expect(context.transport.policyState).not.toHaveBeenCalled(); expect(context.transport.evidence).not.toHaveBeenCalled()
      expect(context.sync.changes).toHaveBeenCalledTimes(3)
      // A fresh, small, actual complete D at the same observed head remains
      // readable; no partial history or failed bounded fold is reused.
      await context.value.preview(context.fixture.request.request_id)
    } else await context.value.preview(context.fixture.request.request_id)
    expect(context.value.view().preview!.records).toEqual(cloud)
    expect(context.value.view().preview!.packet.request.expected_revision).toBe(10)
    expect((await context.outbox.read(signal())).task).toBeNull()
    expect(context.transport.write).not.toHaveBeenCalled(); expect(context.sync.write).not.toHaveBeenCalled()
    expect(context.sync.receipt).not.toHaveBeenCalled()
  })

  it.each(['cumulative-bytes', 'retained-image', 'incomplete-head'] as const)('retains the strictly parsed head across %s failure and refuses an otherwise valid older source', async fault => {
    const context = await setup()
    const rows = (first: number, revision: number, note: string | null = null): OwnerSyncRecord[] =>
      Array.from({ length: 200 }, (_, index) => ({ key: 'asset:bounded-' + String(first + index).padStart(3, '0'),
        kind: 'manual_asset', deleted: false, record_revision: revision, lifecycle_revision: 1,
        field_revisions: { name: 1, cls: 1, value: revision, note: 1 },
        values: { name: 'synthetic bounded source', cls: '现金', value: 0, note } }))
    const batches = fault === 'cumulative-bytes' ? [rows(0, 1), rows(0, 2), rows(0, 10)]
      : fault === 'retained-image' ? [rows(0, 1, '中'.repeat(2000)), rows(200, 10, '中'.repeat(2000))]
      : [rows(0, 1).slice(0, 1)]
    const responses = batches.map((batch, index) => historyPage(batch, 10, index === batches.length - 1,
      fault === 'cumulative-bytes' ? 1536 * 1024 : undefined))
    responses.forEach((response, index) => expect(parseSyncChangesPage(response.rawBody, {
      sinceRevision: 0, limit: 200, ...(index === 0 ? {} : { upperRevision: 10,
        cursor: [batches[index - 1][199].record_revision, batches[index - 1][199].key] as const }),
    }).upper_revision).toBe(10))
    for (const response of responses) context.sync.changes.mockResolvedValueOnce(response)
    await expect(context.value.preview(context.fixture.request.request_id)).rejects.toBeDefined()
    expect(context.value.view().preview).toBeNull(); expect(context.value.isQualified()).toBe(false)
    // The default transport now returns the original real B=head1, which
    // would be fully eligible without the failed read's observed head10.
    await context.value.hydrate()
    await expect(context.value.preview(context.fixture.request.request_id)).rejects.toBeDefined()
    expect(context.transport.policyState).not.toHaveBeenCalled(); expect(context.transport.evidence).not.toHaveBeenCalled()
    expect((await context.outbox.read(signal())).task).toBeNull()
    expect(context.transport.write).not.toHaveBeenCalled(); expect(context.sync.write).not.toHaveBeenCalled()
    // Separate newly constructed managers do not inherit a fictitious
    // persistent floor; the very same source is valid in that new context.
    const separate = context.manager()
    await separate.preview(context.fixture.request.request_id)
    expect(separate.view().preview!.records).toEqual(context.mutable.cloud)
    expect(separate.view().preview!.packet.request.expected_revision).toBe(1)
  })

  it.each(['manual', 'tombstone'] as const)('refuses a supposedly complete D missing its actual B %s record', async missing => {
    const context = await setup(true)
    context.mutable.cloud = context.mutable.cloud.filter(row => missing === 'manual' ? row.kind !== 'manual_asset' : !row.deleted)
    await expect(context.value.preview(context.fixture.request.request_id)).rejects.toBeDefined()
    expect(context.transport.policy).not.toHaveBeenCalled(); expect(context.transport.write).not.toHaveBeenCalled()
    expect((await context.outbox.read(signal())).task).toBeNull()
  })

  it('refuses changed B to L even when the full remote D still matches the old B', async () => {
    const context = await setup(); await context.edit()
    await expect(context.value.preview(context.fixture.request.request_id)).rejects.toBeDefined()
    expect(context.transport.policy).not.toHaveBeenCalled(); expect(context.transport.write).not.toHaveBeenCalled()
    expect((await context.workspace.readLocalState({ signal: signal(), assertActive() {} })).snapshot.entries[0].values.shares).toBe(11)
  })

  it('expires current-action qualification after 60 seconds while retaining its immutable historical result', async () => {
    const context = await setup(); await prepared(context); await context.value.sendOnce(true)
    expect(context.value.isQualified()).toBe(true)
    context.mutable.now += 60_001
    expect(context.value.isQualified()).toBe(false)
    expect(context.value.view().result?.run.request_hash).toBe(context.fixture.requestHash)
    expect(context.transport.write).toHaveBeenCalledOnce()
  })

  it.each(['deadline', 'NaN'] as const)('fails current-action qualification closed at the exact 60-second boundary or invalid clock (%s)', async fault => {
    const context = await setup(); await prepared(context); await context.value.sendOnce(true)
    expect(context.value.isQualified()).toBe(true)
    context.mutable.now = fault === 'deadline' ? NOW + 60_000 : Number.NaN
    expect(context.value.isQualified()).toBe(false)
    expect((await context.outbox.read(signal())).task?.state).toBe('matched')
    expect(context.transport.write).toHaveBeenCalledOnce()
  })

  it('keeps an actually committed attempted marker after local CAS delivery is lost, without sending or clearing it', async () => {
    const context = await setup(); await prepared(context)
    const transaction = IDBDatabase.prototype.transaction
    const lose = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.apply(this, args)
      if (this.name.startsWith('fund-compass-owner-analysis-1:') && args[1] === 'readwrite') {
        tx.addEventListener('complete', () => context.mutable.endpoint = 'https://different-owner.example/api', { once: true })
      }
      return tx
    })
    await expect(context.value.sendOnce(true)).rejects.toBeDefined()
    lose.mockRestore()
    expect((await context.outbox.read(signal())).task?.state).toBe('attempted')
    expect(context.transport.write).not.toHaveBeenCalled()
    context.mutable.endpoint = 'https://synthetic-owner.example/api'
    await expect(context.value.sendOnce(true)).rejects.toBeDefined()
    expect(context.transport.write).not.toHaveBeenCalled()
    expect((await context.outbox.read(signal())).task?.state).toBe('attempted')
  })

  it('never sends or clears when actual attempted CAS commits but its returned value is lost', async () => {
    const context = await setup()
    const originalCas = context.outbox.compareAndSwap
    const delivery = context.manager({ ...context.outbox,
      async compareAndSwap(expected, next, stopped) {
        const actual = await originalCas(expected, next, stopped)
        if (next?.state === 'attempted') throw new Error('synthetic local completion response lost after actual commit')
        return actual
      },
    })
    await delivery.hydrate(); await delivery.preview(context.fixture.request.request_id); await delivery.prepare(true)
    await expect(delivery.sendOnce(true)).rejects.toBeDefined()
    expect((await context.outbox.read(signal())).task?.state).toBe('attempted')
    await expect(delivery.sendOnce(true)).rejects.toBeDefined()
    await expect(delivery.cancelPrepared(true)).rejects.toBeDefined()
    expect(context.transport.write).not.toHaveBeenCalled()
    await delivery.hydrate()
    expect(delivery.view().slot?.task?.state).toBe('attempted')
    expect(delivery.exportTask().task.requestHash).toBe(context.fixture.requestHash)
    context.transport.receipt.mockResolvedValueOnce({ status: 404, rawBody: '{"state":"unknown","error":"analysis_result_unknown"}' })
    await expect(delivery.reconcile()).rejects.toBeDefined()
    expect((await context.outbox.read(signal())).task?.state).toBe('attempted')
    expect(context.transport.write).not.toHaveBeenCalled()
  })

  it('reads the complete Policy timeline only explicitly, with no source/quote/POST/task write', async () => {
    const context = await setup(); await context.value.hydrate()
    const before = await context.outbox.read(signal())
    expect(context.transport.policyState).not.toHaveBeenCalled()
    await context.value.reviewPolicy()
    expect(context.value.view().policyState?.current?.policy_version).toBe(JSON.parse(context.fixture.policy).policy_version)
    expect(context.transport.policyState).toHaveBeenCalledOnce()
    expect(context.transport.policy).not.toHaveBeenCalled(); expect(context.source).not.toHaveBeenCalled()
    expect(context.transport.evidence).not.toHaveBeenCalled(); expect(context.sync.changes).not.toHaveBeenCalled()
    expect(context.transport.write).not.toHaveBeenCalled(); expect(context.transport.receipt).not.toHaveBeenCalled()
    expect(await context.outbox.read(signal())).toEqual(before)
  })

  it('expires at the known next Policy before a minute, retaining the exact historical receipt and source', async () => {
    const context = await setup(), successor = scheduledPolicy(context)
    await prepared(context); await context.value.sendOnce(true)
    expect(context.value.isQualified()).toBe(true)
    expect(context.value.view().qualificationUntil).toBe(NOW + 20_000)
    context.mutable.now = NOW + 19_999; expect(context.value.isQualified()).toBe(true)
    context.mutable.now = NOW + 20_000; expect(context.value.isQualified()).toBe(false)
    const original = await context.outbox.read(signal())
    await context.value.reconcile()
    expect(context.value.view().result?.source_current).toBe(true)
    expect(context.value.view().result?.run.request_hash).toBe(context.fixture.requestHash)
    expect(context.value.view().policyState?.current?.policy_version).toBe(successor.policy_version)
    expect(context.value.isQualified()).toBe(false)
    expect(await context.outbox.read(signal())).toEqual(original)
    expect(context.transport.write).toHaveBeenCalledOnce()
    await context.value.finishMatched(true)
    await context.value.preview('analysis-after-policy-change-0001')
    expect(context.value.view().preview?.packet.request.policy_version).toBe(successor.policy_version)
    expect(context.transport.write).toHaveBeenCalledOnce()
  })

  it('refuses an expired prepared preview before the attempted marker without replacing its original bytes', async () => {
    const context = await setup(); scheduledPolicy(context)
    await prepared(context)
    const original = await context.outbox.read(signal())
    context.mutable.now = NOW + 20_000
    await expect(context.value.sendOnce(true)).rejects.toBeDefined()
    expect(await context.outbox.read(signal())).toEqual(original)
    expect(original.task?.state).toBe('prepared'); expect(context.transport.write).not.toHaveBeenCalled()
    await expect(context.value.preview('cannot-replace-old-prepared')).rejects.toBeDefined()
    expect(await context.outbox.read(signal())).toEqual(original)
    await context.value.cancelPrepared(true)
    await context.value.preview('explicit-new-policy-preview-0001')
    expect(context.value.view().preview?.packet.requestHash).not.toBe(context.fixture.requestHash)
    expect(context.transport.write).not.toHaveBeenCalled()
  })

  it('does not renew an old analysis merely by reading Policy versions', async () => {
    const context = await setup(); await prepared(context); await context.value.sendOnce(true)
    expect(context.value.isQualified()).toBe(true)
    const original = await context.outbox.read(signal()), changes = context.sync.changes.mock.calls.length
    await context.value.reviewPolicy()
    expect(context.value.isQualified()).toBe(false)
    expect(context.value.view().result?.run.request_hash).toBe(context.fixture.requestHash)
    expect(await context.outbox.read(signal())).toEqual(original)
    expect(context.sync.changes).toHaveBeenCalledTimes(changes)
    expect(context.transport.write).toHaveBeenCalledOnce(); expect(context.transport.receipt).not.toHaveBeenCalled()
  })

  it('rejects an observed wall-clock rollback inside the otherwise valid minute, without self-renewal', async () => {
    const context = await setup(); await prepared(context); await context.value.sendOnce(true)
    context.mutable.now = NOW + 30_000; expect(context.value.isQualified()).toBe(true)
    context.mutable.now = NOW + 20_000; expect(context.value.isQualified()).toBe(false)
    context.mutable.now = NOW + 30_001; expect(context.value.isQualified()).toBe(false)
    expect(context.value.view().result?.run.request_hash).toBe(context.fixture.requestHash)
    expect(context.transport.write).toHaveBeenCalledOnce()
  })

  it('uses monotonic elapsed time to expire even if the wall clock stops advancing', async () => {
    const context = await setup()
    const monotonic = vi.spyOn(globalThis.performance, 'now').mockReturnValue(100)
    await prepared(context)
    await context.value.sendOnce(true); expect(context.value.isQualified()).toBe(true)
    monotonic.mockReturnValue(60_100); expect(context.value.isQualified()).toBe(false)
    expect(context.value.view().result?.run.request_hash).toBe(context.fixture.requestHash)
    expect(context.transport.write).toHaveBeenCalledOnce()
  })
})

describe('explicit full-profile analysis source selection and task continuity', () => {
  it('previews, prepares, sends once and qualifies the real SQLite v6 run after applying full B3 while historical v4 B1 remains unchanged', async () => {
    const { context, backend, handle, guard, before } = await actualFullAnalysis()
    const state = await handle.readFullSyncState(guard)
    expect(state.local.sync).toEqual(before.local.sync)
    expect(state.local.sync?.base?.pulledRevision).toBe(1)
    expect(state.fullSync.base?.pulledRevision).toBe(3)
    expect(state.local.portfolio!.manual).toHaveLength(2)
    expect(state.local.portfolio!.manual.some(row => row.deleted)).toBe(true)
    expect(Object.is(state.local.portfolio!.manual.find(row => !row.deleted)?.values.value, -0)).toBe(true)
    await context.value.hydrate(); await context.value.preview(backend.request.request_id)
    const preview = context.value.view().preview!
    expect(preview.packet).toMatchObject({ rawBody: backend.rawBody, requestHash: backend.requestHash })
    expect([...preview.records].sort((a, b) => compareSyncKeys(a.key, b.key))).toEqual(backend.currentRecords)
    expect(preview.packet.request.evidence.map(row => row.code)).toEqual(['510300'])
    await context.value.prepare(true)
    context.transport.write.mockImplementationOnce(async packet => {
      expect(packet.rawBody).toBe(backend.rawBody); expect(packet.requestHash).toBe(backend.requestHash)
      expect((await context.outbox.read(signal())).task?.state).toBe('attempted')
      return { status: 200, rawBody: backend.response }
    })
    await context.value.sendOnce(true)
    const response = JSON.parse(backend.response)
    expect(context.value.view().result).toEqual(response)
    expect(context.value.view().result?.run.source).toEqual(response.run.source)
    expect(context.value.view().result?.run.source.record_count).toBe(3)
    expect(context.value.view().result?.run.components).toHaveLength(1)
    expect(context.value.view().result?.run.components[0].holding.current_weight).toBe(100)
    expect(context.value.isQualified()).toBe(true)
    expect((await context.outbox.read(signal())).task).toMatchObject({ state: 'matched', rawBody: backend.rawBody, requestHash: backend.requestHash })
    expect(context.transport.write).toHaveBeenCalledOnce(); expect(context.sync.write).not.toHaveBeenCalled()
    expect((await handle.readFullSyncState(guard)).local).toEqual(state.local)
  })

  it.each(['missing-deleted-manual', 'zero-sign'] as const)('refuses server source_current as sufficient when full actual D disagrees (%s), preserving only the original task for receipt', async fault => {
    const { context, backend } = await actualFullAnalysis()
    await context.value.hydrate(); await context.value.preview(backend.request.request_id); await context.value.prepare(true)
    const badRecords = backend.currentRecords.filter(row => fault !== 'missing-deleted-manual' || !row.deleted)
      .map(row => fault === 'zero-sign' && row.kind === 'manual_asset' && !row.deleted
        ? { ...row, values: { ...row.values, value: 0 } } : row)
      .sort((a, b) => a.record_revision - b.record_revision || compareSyncKeys(a.key, b.key))
    const badRaw = canonicalOwnerLocal({ upper_revision: 3, changes: badRecords, next_cursor: null, complete: true })
    expect(parseSyncChangesPage(badRaw, { sinceRevision: 0, limit: 200 }).upper_revision).toBe(3)
    context.sync.changes.mockResolvedValueOnce({ status: 200, rawBody: badRaw })
    await expect(context.value.sendOnce(true)).rejects.toBeDefined()
    expect(context.value.isQualified()).toBe(false); expect(context.value.view().result).toBeNull()
    expect((await context.outbox.read(signal())).task).toMatchObject({ state: 'matched', rawBody: backend.rawBody, requestHash: backend.requestHash })
    await expect(context.value.sendOnce(true)).rejects.toBeDefined()
    await context.value.reconcile()
    expect(context.value.isQualified()).toBe(true)
    expect(context.transport.receipt.mock.calls[0][0]).toMatchObject({ rawBody: backend.rawBody, requestHash: backend.requestHash })
    expect(context.transport.write).toHaveBeenCalledOnce()
  })

  it('uses the actually refreshed full B rather than historical v4 B, retaining typed zero/null and every tombstone', async () => {
    const context = await setup(true, 0, 1, 'v6'), handle = context.activeWorkspace()
    const guard = { signal: signal(), assertActive() {} }, before = await handle.readFullSyncState(guard)
    context.mutable.cloud = context.mutable.cloud.map(row => row.kind === 'manual_asset'
      ? { ...row, record_revision: 2, field_revisions: { ...row.field_revisions, value: 2 }, values: { ...row.values, value: -0 } }
      : row.key === KEY ? { ...row, record_revision: 3,
        field_revisions: { ...row.field_revisions, shares: 3, cost: 3, target_weight: 3 },
        values: { ...row.values, shares: -0, cost: null, target_weight: 0 } } : row)
    context.mutable.cloudRevision = 3
    await handle.refreshFullSync(await buildOwnerWorkspaceFullSyncRefreshRequest(TARGET, {
      id: 'analysis-apply-full-refresh-0001', expected: before,
      completeBaseline: { pulledRevision: 3, records: context.mutable.cloud }, minimumObservedRevision: 3, resolutions: [],
    }), guard)
    const actual = await handle.readFullSyncState(guard)
    expect(actual.local.sync).toEqual(before.local.sync)
    expect(actual.local.sync?.base?.pulledRevision).toBe(1)
    expect(actual.fullSync.base?.pulledRevision).toBe(3)
    expect(planOwnerPortfolioCloudIntent(actual.fullSync.base, actual.local.snapshot, actual.local.portfolio)).toEqual({ issues: [], operations: [] })
    const rawBody = canonicalOwnerLocal({ upper_revision: 3,
      changes: [...context.mutable.cloud].sort((a, b) => a.record_revision - b.record_revision || compareSyncKeys(a.key, b.key)),
      next_cursor: null, complete: true,
    })
    expect(parseSyncChangesPage(rawBody, { sinceRevision: 0, limit: 200 }).changes).toHaveLength(3)
    context.sync.changes.mockImplementation(async () => ({ status: 200, rawBody }))
    await context.value.preview('analysis-active-full-base-0001')
    const preview = context.value.view().preview!
    expect(preview.packet.request.expected_revision).toBe(3)
    expect([...preview.records].sort((a, b) => compareSyncKeys(a.key, b.key))).toEqual(context.mutable.cloud)
    expect(Object.is(preview.records.find(row => row.key === KEY)?.values.shares, -0)).toBe(true)
    expect(preview.records.find(row => row.key === KEY)?.values.cost).toBeNull()
    expect(Object.is(preview.records.find(row => row.kind === 'manual_asset')?.values.value, -0)).toBe(true)
    expect(preview.records.find(row => row.kind === 'manual_asset')?.values.note).toBeNull()
    expect(preview.records.filter(row => row.deleted)).toHaveLength(1)
    expect(preview.packet.request.evidence.map(row => row.code)).toEqual(['510300'])
    expect(context.transport.evidence).toHaveBeenCalledOnce(); expect(context.transport.write).not.toHaveBeenCalled()
    expect((await context.outbox.read(signal())).task).toBeNull()
  })

  it.each(['unknown', 'v5', 'missing-full-base'] as const)('refuses %s without falling back to the retained historical v4 base', async fault => {
    const context = await setup(true, 0, 1, 'v6'), actual = await context.source(signal())
    if (actual.profile !== 'v6') throw new Error('actual v6 fixture required')
    expect(actual.state.local.sync?.base?.pulledRevision).toBe(1)
    context.source.mockResolvedValueOnce(fault === 'missing-full-base'
      ? { ...actual, state: { ...actual.state, fullSync: { ...actual.state.fullSync, base: null } } }
      : { ...actual, profile: fault === 'v5' ? 'v5' : undefined } as unknown as OwnerAnalysisLocalSource)
    await expect(context.value.preview('analysis-explicit-profile-0001')).rejects.toBeDefined()
    expect(context.sync.changes).not.toHaveBeenCalled(); expect(context.transport.policyState).not.toHaveBeenCalled()
    expect(context.transport.evidence).not.toHaveBeenCalled(); expect(context.transport.write).not.toHaveBeenCalled()
    expect((await context.outbox.read(signal())).task).toBeNull()
  })

  it.each(['name', 'cls', 'value', 'note'] as const)('compares every applied full-B manual field with actual D, not only head and count (%s)', async field => {
    const context = await setup(true, 0, 1, 'v6')
    const wrong = field === 'name' ? 'different manual name' : field === 'cls' ? '其他' : field === 'value' ? -0 : ''
    const cloud = context.mutable.cloud.map(row => row.kind === 'manual_asset'
      ? { ...row, values: { ...row.values, [field]: wrong } } : row)
    context.sync.changes.mockResolvedValueOnce({ status: 200, rawBody: canonicalOwnerLocal({
      upper_revision: 1, changes: cloud, next_cursor: null, complete: true,
    }) })
    await expect(context.value.preview('analysis-full-business-diff-0001')).rejects.toBeDefined()
    expect(context.transport.policyState).not.toHaveBeenCalled(); expect(context.transport.write).not.toHaveBeenCalled()
    expect(context.value.view().preview).toBeNull(); expect((await context.outbox.read(signal())).task).toBeNull()
  })

  it('keeps an original v4 prepared task unchanged after actual upgrade, requiring explicit cancellation instead of rebuilding it for v6', async () => {
    const context = await setup(); await prepared(context)
    const original = await context.outbox.read(signal())
    await context.upgradeFull(); context.value.invalidate(); await context.value.hydrate()
    expect((await context.source(signal())).profile).toBe('v6')
    await expect(context.value.preview('cannot-rewrite-original-v4-task')).rejects.toBeDefined()
    expect(await context.outbox.read(signal())).toEqual(original)
    expect(context.transport.write).not.toHaveBeenCalled()
    await context.value.cancelPrepared(true)
    expect((await context.outbox.read(signal())).task).toBeNull()
  })

  it('rejects a preview after an actual history-only write although fund/manual B to L still has no intent', async () => {
    const context = await setup(true, 0, 1, 'v6'), handle = context.activeWorkspace()
    await context.value.preview('analysis-full-history-preimage-0001')
    const guard = { signal: signal(), assertActive() {} }, before = await handle.readLocalState(guard)
    await handle.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(TARGET, {
      id: 'analysis-history-write-0001', expected: before, command: { type: 'append_observation', observation: {
        id: 'analysis-history-observation', kind: 'observation', observed_at: '2026-10-24T02:00:00Z',
        date: '2026-10-24', calendar: 'Asia/Shanghai', value: 0, cost: null,
        holdings: [{ kind: 'manual', key: 'asset:synthetic-cash', name: '合成现金', cls: '现金', value: 0, cost: null }],
      } },
    }), guard)
    const after = await handle.readFullSyncState(guard)
    expect(after.local.portfolio!.history).toHaveLength(before.portfolio!.history.length + 1)
    expect(planOwnerPortfolioCloudIntent(after.fullSync.base, after.local.snapshot, after.local.portfolio)).toEqual({ issues: [], operations: [] })
    await expect(context.value.prepare(true)).rejects.toBeDefined()
    expect((await context.outbox.read(signal())).task).toBeNull(); expect(context.transport.write).not.toHaveBeenCalled()
    expect((await handle.readLocalState(guard)).portfolio).toEqual(after.local.portfolio)
  })

  it('reconciles the exact original v4 unknown task after real v6 upgrade as history, without another POST or current qualification', async () => {
    const context = await setup(); await prepared(context)
    context.transport.write.mockRejectedValueOnce(new Error('synthetic response lost after submission'))
    await expect(context.value.sendOnce(true)).rejects.toBeDefined()
    const original = await context.outbox.read(signal()), policyReads = context.transport.policyState.mock.calls.length
    await context.upgradeFull(); context.value.invalidate(); await context.value.hydrate()
    await context.value.reconcile()
    expect(context.transport.write).toHaveBeenCalledOnce(); expect(context.transport.receipt).toHaveBeenCalledOnce()
    expect(context.transport.receipt.mock.calls[0][0]).toMatchObject({
      rawBody: original.task!.rawBody, requestHash: original.task!.requestHash,
    })
    expect((await context.outbox.read(signal())).task).toEqual({ ...original.task, state: 'matched' })
    expect(context.value.view().result?.source_current).toBe(true)
    expect(context.value.view().result?.run.request_hash).toBe(context.fixture.requestHash)
    expect(context.value.view().message).toContain('本机或完整持仓来源已变化')
    expect(context.value.isQualified()).toBe(false)
    expect(context.transport.policyState).toHaveBeenCalledTimes(policyReads)
    await expect(context.value.sendOnce(true)).rejects.toBeDefined()
    expect(context.transport.write).toHaveBeenCalledOnce()
  })
})

describe('real Admin HTTP future Policy lifecycle with an unchanged full v6 source', () => {
  it('expires A and B exactly at the next effective instant, retains original receipts as history, and requires explicit new B/C original packets', async () => {
    const { context, backend, handle, guard } = await actualFullAnalysis(), lifecycle = ownerAdminPolicyLifecycleBackendFixture()
    const [a, b, c] = lifecycle.stages
    expect(lifecycle.stages.map(stage => stage.key)).toEqual(['a', 'b', 'c'])
    expect(lifecycle.currentRecords).toEqual(backend.currentRecords); expect(lifecycle.evidence).toBe(backend.evidence)
    let current = a
    context.mutable.now = Date.parse(a.now)
    context.transport.policyState.mockImplementation(async () => ({ status: 200, rawBody: current.policyStateRaw }))
    context.transport.evidence.mockResolvedValue({ status: 200, rawBody: lifecycle.evidence })
    context.sync.changes.mockResolvedValue({ status: 200, rawBody: lifecycle.currentChangesRaw })
    context.transport.write.mockImplementation(async packet => {
      expect(packet.rawBody).toBe(current.rawBody); expect(packet.requestHash).toBe(current.requestHash)
      expect((await context.outbox.read(signal())).task?.state).toBe('attempted')
      return { status: 200, rawBody: current.responseRaw }
    })
    context.transport.receipt.mockImplementation(async packet => {
      const key = lifecycle.stages.find(stage => stage.requestHash === packet.requestHash)?.key
      const rawBody = key === 'a' ? current.priorReceipts.a : key === 'b' ? current.priorReceipts.b : undefined
      if (!rawBody) throw new Error('actual original stage receipt required')
      expect(packet.rawBody).toBe(lifecycle.stages.find(stage => stage.key === key)!.rawBody)
      return { status: 200, rawBody }
    })
    const sourceBefore = await handle.readFullSyncState(guard)
    await context.value.hydrate(); const empty = await context.outbox.read(signal())
    await context.value.reviewPolicy()
    expect(context.value.view().policyState?.history.map(row => row.policy_version)).toEqual([
      lifecycle.policies.c.policy_version, lifecycle.policies.b.policy_version, lifecycle.policies.a.policy_version,
    ])
    expect(context.value.view().policyState?.current?.policy_version).toBe(a.request.policy_version)
    expect(context.source).not.toHaveBeenCalled(); expect(context.sync.changes).not.toHaveBeenCalled()
    expect(context.transport.evidence).not.toHaveBeenCalled(); expect(context.transport.write).not.toHaveBeenCalled()
    expect(await context.outbox.read(signal())).toEqual(empty)
    let sourceSha = '', originalContext = ''
    for (const stage of [a, b, c]) {
      current = stage; context.mutable.now = Date.parse(stage.now)
      await context.value.preview(stage.request.request_id)
      expect(context.value.view().preview?.packet).toMatchObject({ rawBody: stage.rawBody, requestHash: stage.requestHash })
      await context.value.prepare(true); await context.value.sendOnce(true)
      const result = context.value.view().result!, original = await context.outbox.read(signal())
      expect(result).toEqual(JSON.parse(stage.responseRaw)); expect(context.value.isQualified()).toBe(true)
      expect(result.run.source).toEqual(JSON.parse(a.responseRaw).run.source)
      expect(result.run.policy.policy_version).toBe(stage.request.policy_version)
      if (stage.key === 'a') { sourceSha = result.run.source.sha256; originalContext = original.task!.contextHash }
      expect(result.run.source.sha256).toBe(sourceSha); expect(original.task!.contextHash).toBe(originalContext)
      expect(await handle.readFullSyncState(guard)).toEqual(sourceBefore)
      if (stage.key === 'c') break
      const next = stage.key === 'a' ? b : c, deadline = Date.parse(JSON.parse(stage.policyStateRaw).next_effective_at)
      expect(deadline).toBe(Date.parse(next.now)); expect(deadline - Date.parse(stage.now)).toBeLessThan(60_000)
      expect(context.value.view().qualificationUntil).toBe(deadline)
      context.mutable.now = deadline - 1; expect(context.value.isQualified()).toBe(true)
      context.mutable.now = deadline; expect(context.value.isQualified()).toBe(false)
      expect(await context.outbox.read(signal())).toEqual(original)
      await expect(context.value.preview('cannot-overwrite-matched-policy-run')).rejects.toBeDefined()
      current = next
      await context.value.reconcile()
      expect(context.value.view().result?.source_current).toBe(true)
      expect(context.value.view().result?.run.request_hash).toBe(stage.requestHash)
      expect(context.value.view().result?.run.policy.policy_version).toBe(stage.request.policy_version)
      expect(context.value.view().policyState?.current?.policy_version).toBe(next.request.policy_version)
      expect(context.value.isQualified()).toBe(false)
      expect(await context.outbox.read(signal())).toEqual(original)
      await context.value.finishMatched(true)
      expect((await context.outbox.read(signal())).task).toBeNull()
    }
    expect(context.transport.write).toHaveBeenCalledTimes(3); expect(context.transport.receipt).toHaveBeenCalledTimes(2)
    expect(context.transport.policy).not.toHaveBeenCalled(); expect(context.sync.write).not.toHaveBeenCalled()
    expect(context.value.view().policyState?.current?.policy_version).toBe(c.request.policy_version)
    expect(context.value.view().policyState?.next_effective_at).toBeNull()
  })

  it('spends the original real A proof during Evidence work and rejects at B even though C is also scheduled', async () => {
    const { context } = await actualFullAnalysis(), lifecycle = ownerAdminPolicyLifecycleBackendFixture(), [a, b] = lifecycle.stages
    context.mutable.now = Date.parse(a.now)
    context.transport.policyState.mockResolvedValue({ status: 200, rawBody: a.policyStateRaw })
    let finish!: (value: { status: number; rawBody: string }) => void
    context.transport.evidence.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const reading = context.value.preview(a.request.request_id), rejected = expect(reading).rejects.toBeDefined()
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    context.mutable.now = Date.parse(b.now)
    finish({ status: 200, rawBody: lifecycle.evidence }); await rejected
    expect(context.value.view().preview).toBeNull(); expect(context.value.isQualified()).toBe(false)
    expect(context.transport.policyState).toHaveBeenCalledOnce(); expect(context.transport.write).not.toHaveBeenCalled()
    expect((await context.outbox.read(signal())).task).toBeNull()
  })
})
