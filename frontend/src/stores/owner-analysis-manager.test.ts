/** Real task/workspace IDB and raw contracts; only HTTP is synthetic. */
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBDatabase, IDBFactory } from 'fake-indexeddb'
import { createOwnerAnalysisManager, type OwnerAnalysisManager } from './owner-analysis-manager'
import { openOwnerAnalysisOutbox, type OwnerAnalysisOutbox } from './owner-analysis-outbox'
import { openOwnerWorkspace, upgradeOwnerWorkspaceSync, buildOwnerWorkspaceAdoptLocalRequest,
  buildOwnerWorkspaceLinkCloudRequest, buildOwnerWorkspaceEditLocalRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard } from './owner-workspace'
import type { OwnerAnalysisLocalSource } from './watchlist'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { planOwnerWorkspaceCloudIntent } from '@/utils/owner-workspace-sync'
import { compareSyncKeys, type OwnerSyncRecord } from '@/utils/ownerSyncContract'
import { ownerAnalysisBackendFixture } from '@/utils/ownerAnalysisContract.fixtures'
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
async function setup(extra = false, additionalManuals = 0) {
  const fixture = ownerAnalysisBackendFixture(), factory = new IDBFactory(), mutable = {
    endpoint: 'https://synthetic-owner.example/api', generation: 1, authenticated: true, sourceEpoch: 0, now: NOW,
    cloud: [...records(extra), ...Array.from({ length: additionalManuals }, (_, index): OwnerSyncRecord => ({
      key: 'asset:extra-' + String(index).padStart(3, '0'), kind: 'manual_asset', deleted: false,
      record_revision: 1, lifecycle_revision: 1, field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
      values: { name: '合成手工资产', cls: '现金', value: 0, note: null },
    }))].sort((a, b) => compareSyncKeys(a.key, b.key)),
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
  const workspace = await upgradeOwnerWorkspaceSync(factory, TARGET, local, guard); handles.push(workspace)
  await workspace.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'analysis-link-0001',
    expected: await workspace.readSyncState(guard), base: { pulledRevision: 1, records: mutable.cloud } }), guard)
  const outbox = await openOwnerAnalysisOutbox(factory, TARGET, signal(), true); handles.push(outbox)
  const source = vi.fn(async (active: AbortSignal): Promise<OwnerAnalysisLocalSource> => {
    const epoch = mutable.sourceEpoch
    const assertActive = () => { if (epoch !== mutable.sourceEpoch) throw new Error('real source epoch changed') }
    const actualGuard = { signal: active, assertActive }
    const state = await workspace.readSyncState(actualGuard)
    if (active.aborted || state.local.outbox.entry || state.sync.pending || !state.sync.base) throw new Error('source not ready')
    const intent = planOwnerWorkspaceCloudIntent(state.sync.base, state.local.snapshot)
    if (intent.issues.length || intent.operations.length) throw new Error('actual B to L is not unchanged')
    const preimage = canonicalOwnerLocal(state)
    return Object.freeze({ targetFingerprint: TARGET, state, preimage, assertActive,
      async verify(stopped: AbortSignal) {
        assertActive()
        const current = await workspace.readSyncState({ signal: stopped, assertActive })
        if (stopped.aborted || canonicalOwnerLocal(current) !== preimage) throw new Error('actual full IDB preimage changed')
      },
    })
  })
  const transport = {
    targetFingerprint: TARGET,
    write: vi.fn(async (_packet: BuiltOwnerAnalysisRequest, _signal: AbortSignal) => ({ status: 200, rawBody: fixture.response })),
    receipt: vi.fn(async (_packet: BuiltOwnerAnalysisRequest, _signal: AbortSignal) => ({ status: 200, rawBody: JSON.stringify({ state: 'matched', status: 200, result: JSON.parse(fixture.response) }) })),
    policy: vi.fn(async (_signal: AbortSignal) => ({ status: 200, rawBody: fixture.policy })),
    evidence: vi.fn(async (_code: string, _signal: AbortSignal) => ({ status: 200, rawBody: fixture.evidence })),
  }
  const sync = { targetFingerprint: TARGET,
    write: vi.fn(async () => { throw new Error('analysis must not write Owner sync') }),
    receipt: vi.fn(async () => { throw new Error('analysis must not read a sync write receipt') }),
    changes: vi.fn(async (_parameters: Parameters<OwnerSyncCandidateTransport['changes']>[0], _signal: AbortSignal) => ({ status: 200, rawBody: JSON.stringify({ upper_revision: 1,
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
  return { fixture, factory, workspace, outbox, mutable, source, transport, sync, manager, value, edit }
}
type Setup = Awaited<ReturnType<typeof setup>>
async function prepared(context: Setup) {
  await context.value.hydrate(); await context.value.preview(context.fixture.request.request_id); await context.value.prepare(true)
}

describe('real source-bound Owner analysis manager', () => {
  it('constructs with no task reads, source reads, quote, sync or analysis HTTP', async () => {
    const context = await setup()
    const read = vi.fn(context.outbox.read)
    context.manager({ ...context.outbox, read })
    expect(read).not.toHaveBeenCalled(); expect(context.source).not.toHaveBeenCalled()
    for (const call of [context.transport.write, context.transport.receipt, context.transport.policy,
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
})
