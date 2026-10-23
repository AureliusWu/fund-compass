/** Independent source/stream audit using actual workspace and task transactions. */
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { createOwnerAnalysisManager, type OwnerAnalysisManager } from './owner-analysis-manager'
import { openOwnerAnalysisOutbox, type OwnerAnalysisOutbox } from './owner-analysis-outbox'
import { openOwnerWorkspace, upgradeOwnerWorkspaceSync, buildOwnerWorkspaceAdoptLocalRequest,
  buildOwnerWorkspaceLinkCloudRequest, type OwnerWorkspace } from './owner-workspace'
import type { OwnerAnalysisLocalSource } from './watchlist'
import type { OwnerSyncCandidateTransport } from './ownerSyncCandidate'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { planOwnerWorkspaceCloudIntent } from '@/utils/owner-workspace-sync'
import { compareSyncKeys, parseSyncChangesPage, type OwnerSyncRecord } from '@/utils/ownerSyncContract'
import { ownerAnalysisBackendFixture } from '@/utils/ownerAnalysisContract.fixtures'

const TARGET = '7'.repeat(64), KEY = '510300::synthetic-account'
const NOW = Date.parse('2026-10-24T00:00:00Z')
const signal = () => new AbortController().signal
const workspaces: OwnerWorkspace[] = [], outboxes: OwnerAnalysisOutbox[] = [], managers: OwnerAnalysisManager[] = []
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  const forbidden = () => { throw new Error('ambient storage/network forbidden') }
  vi.stubGlobal('fetch', forbidden)
  vi.stubGlobal('indexedDB', { open: forbidden })
  vi.stubGlobal('localStorage', { getItem: forbidden, setItem: forbidden })
})
afterEach(() => {
  managers.splice(0).forEach(item => item.close())
  outboxes.splice(0).forEach(item => item.close())
  workspaces.splice(0).forEach(item => item.close())
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function setup(baseRevision: 1 | 2, manualCount = 0) {
  const fixture = ownerAnalysisBackendFixture(), factory = new IDBFactory()
  const older: OwnerSyncRecord = {
    key: KEY, kind: 'holding', deleted: false, record_revision: 1, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: 1, cost: 1, target_weight: 1 },
    values: { name: 'synthetic private analysis fund', shares: 10, cost: 1, target_weight: 20 },
  }
  const current: OwnerSyncRecord = baseRevision === 1 ? older : {
    ...older, record_revision: 2, field_revisions: { ...older.field_revisions, shares: 2 },
    values: { ...older.values, shares: 11 },
  }
  const manuals: OwnerSyncRecord[] = Array.from({ length: manualCount }, (_, index) => ({
    key: 'asset:stream-' + String(index).padStart(3, '0'), kind: 'manual_asset', deleted: false,
    record_revision: 1, lifecycle_revision: 1, field_revisions: { name: 1, cls: 1, value: 1, note: 1 },
    values: { name: '合成现金', cls: '现金', value: 0, note: null },
  }))
  const baseline = [current, ...manuals].sort((a, b) => compareSyncKeys(a.key, b.key))
  const history = [...[older, ...manuals].sort((a, b) => compareSyncKeys(a.key, b.key)), ...(baseRevision === 2 ? [current] : [])]
  const guard = { signal: signal(), assertActive() { if (this.signal.aborted) throw new Error('aborted') } }
  const legacy = await openOwnerWorkspace(factory, TARGET); workspaces.push(legacy)
  const archive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: null,
    v2Raw: JSON.stringify([{ code: '510300', name: current.values.name, account: 'synthetic-account',
      position_kind: 'holding', shares: current.values.shares, cost: 1, target_weight: 20,
      updated_at: '2026-10-23T00:00:00Z' }]) }
  const backup = await buildOwnerLegacyWorkspaceBackup(archive)
  const adopted = await legacy.adoptLocal(await buildOwnerWorkspaceAdoptLocalRequest(TARGET, {
    id: 'analysis-audit-adopt-0001', expected: await legacy.readLocalState(guard),
    sourceArchive: archive, backupSha256: backup.sha256,
  }), guard)
  const workspace = await upgradeOwnerWorkspaceSync(factory, TARGET, adopted, guard); workspaces.push(workspace)
  await workspace.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, {
    id: 'analysis-audit-link-0001', expected: await workspace.readSyncState(guard),
    base: { pulledRevision: baseRevision, records: baseline },
  }), guard)
  const outbox = await openOwnerAnalysisOutbox(factory, TARGET, signal(), true); outboxes.push(outbox)
  const source = async (stopped: AbortSignal): Promise<OwnerAnalysisLocalSource> => {
    const assertActive = () => { if (stopped.aborted) throw new Error('aborted') }
    const state = await workspace.readSyncState({ signal: stopped, assertActive })
    if (!state.sync.base || state.sync.pending || state.local.outbox.entry) throw new Error('source unavailable')
    const intent = planOwnerWorkspaceCloudIntent(state.sync.base, state.local.snapshot)
    if (intent.operations.length || intent.issues.length) throw new Error('source changed')
    const preimage = canonicalOwnerLocal(state)
    return Object.freeze({ targetFingerprint: TARGET, state, preimage, assertActive,
      async verify(active: AbortSignal) {
        const actual = await workspace.readSyncState({ signal: active, assertActive })
        if (active.aborted || canonicalOwnerLocal(actual) !== preimage) throw new Error('source changed')
      },
    })
  }
  const changes = vi.fn(async (_parameters: Parameters<OwnerSyncCandidateTransport['changes']>[0], _signal: AbortSignal) => ({ status: 200,
    rawBody: JSON.stringify({ upper_revision: baseRevision, changes: history, next_cursor: null, complete: true }) }))
  const forbiddenWrite = vi.fn(async () => { throw new Error('audit must not send') })
  const transport = { targetFingerprint: TARGET, write: forbiddenWrite, receipt: forbiddenWrite,
    policy: vi.fn(async () => ({ status: 200, rawBody: fixture.policy })),
    policyState: vi.fn(async () => ({ status: 200, rawBody: JSON.stringify({
      schema_version: 'owner-policy-state-1', observed_at: new Date(NOW).toISOString(),
      current: JSON.parse(fixture.policy), history: [JSON.parse(fixture.policy)], next_effective_at: null,
    }) })),
    evidence: vi.fn(async () => ({ status: 200, rawBody: fixture.evidence })),
  }
  const manager = createOwnerAnalysisManager({ outbox, source, transport,
    sync: { targetFingerprint: TARGET, changes, write: forbiddenWrite, receipt: forbiddenWrite },
    session: () => ({ authenticated: true, generation: 1 }), endpoint: () => 'https://synthetic.example/api',
    changed() {}, now: () => NOW,
  }); managers.push(manager)
  return { fixture, manager, outbox, changes, transport, history, current, baseRevision, baseline }
}

describe('independent complete-source stream checks', () => {
  it('folds lawful historical revisions of one key before comparing complete D with the applied B', async () => {
    const context = await setup(2)
    const response = await context.changes({ sinceRevision: 0, limit: 200 }, signal())
    // This is the actual sync endpoint contract: one current identity may have
    // multiple ordered immutable change records since revision zero.
    expect(parseSyncChangesPage(response.rawBody, { sinceRevision: 0, limit: 200 }).changes).toHaveLength(2)
    await expect(context.manager.preview('analysis-audit-history-0001')).resolves.toBeUndefined()
    expect(context.manager.view().preview?.records).toEqual([context.current])
    expect(context.manager.view().preview?.packet.request.expected_revision).toBe(2)
    expect((await context.outbox.read(signal())).task).toBeNull()
    expect(context.transport.write).not.toHaveBeenCalled()
  })

  it('folds the same key across two fixed-upper pages, retaining manual zero/null and the latest revision', async () => {
    const context = await setup(2, 199)
    context.changes.mockImplementation(async parameters => {
      expect(parameters.sinceRevision).toBe(0)
      if (!parameters.cursor) return { status: 200, rawBody: JSON.stringify({ upper_revision: 2,
        changes: context.history.slice(0, 200), next_cursor: [1, context.history[199]!.key], complete: false }) }
      expect(parameters.upperRevision).toBe(2)
      expect(parameters.cursor).toEqual([1, context.history[199]!.key])
      return { status: 200, rawBody: JSON.stringify({ upper_revision: 2,
        changes: [context.current], next_cursor: null, complete: true }) }
    })
    await expect(context.manager.preview('analysis-audit-paged-0001')).resolves.toBeUndefined()
    expect(context.changes).toHaveBeenCalledTimes(2)
    expect(context.manager.view().preview?.records).toEqual(context.baseline)
    expect((await context.outbox.read(signal())).task).toBeNull()
    expect(context.transport.write).not.toHaveBeenCalled()
  })

  it.each(['upper-drift', 'backward-order', 'duplicate-point'] as const)(
    'still rejects incompatible history after the latest-record fold (%s)', async fault => {
      const context = await setup(2, 199)
      context.changes.mockImplementation(async parameters => {
        if (!parameters.cursor) return { status: 200, rawBody: JSON.stringify({ upper_revision: 2,
          changes: context.history.slice(0, 200), next_cursor: [1, context.history[199]!.key], complete: false }) }
        return { status: 200, rawBody: JSON.stringify({ upper_revision: fault === 'upper-drift' ? 3 : 2,
          changes: fault === 'backward-order' ? [context.history[0]]
            : fault === 'duplicate-point' ? [context.current, context.current] : [context.current],
          next_cursor: null, complete: true }) }
      })
      await expect(context.manager.preview('analysis-audit-bad-page-0001')).rejects.toBeDefined()
      expect(context.manager.view().preview).toBeNull()
      expect((await context.outbox.read(signal())).task).toBeNull()
      expect(context.transport.write).not.toHaveBeenCalled()
    },
  )

  it('retains a strictly observed higher head when a source comparison fails, refusing later server rollback', async () => {
    const context = await setup(1)
    const newer = { ...context.current, record_revision: 2,
      field_revisions: { ...context.current.field_revisions, shares: 2 },
      values: { ...context.current.values, shares: 11 } }
    context.changes.mockResolvedValueOnce({ status: 200,
      rawBody: JSON.stringify({ upper_revision: 2, changes: [newer], next_cursor: null, complete: true }) })
    await expect(context.manager.preview('analysis-audit-observed-0001')).rejects.toBeDefined()
    // The same session has now observed head 2. Returning the old B at head 1
    // does not erase that observation or restore current-action qualification.
    await expect(context.manager.preview('analysis-audit-regressed-0001')).rejects.toBeDefined()
    expect(context.manager.view().preview).toBeNull()
    expect((await context.outbox.read(signal())).task).toBeNull()
    expect(context.transport.write).not.toHaveBeenCalled()
  })
})
