/** Independent audit reproductions. Actual v6 workspace/core plus synthetic
 * transport; only measured elapsed time is injected. No business validator or
 * workspace success image is replaced. No actual HTTP/browser/cloud proof. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import {
  openOwnerWorkspace, upgradeOwnerWorkspaceSync, upgradeOwnerWorkspacePortfolio, upgradeOwnerWorkspaceFullSync,
  buildOwnerWorkspaceAdoptLocalRequest, buildOwnerWorkspaceLinkCloudRequest,
  buildOwnerWorkspacePortfolioUpgradeBackup, buildOwnerWorkspacePortfolioUpgradeRequest,
  buildOwnerWorkspaceFullSyncUpgradeRequest, buildOwnerWorkspaceFullSyncLinkRequest, buildOwnerWorkspaceEditLocalRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard,
} from './owner-workspace'
import { createOwnerPortfolioWorkspaceSync } from './ownerPortfolioWorkspaceSync'
import { canonicalOwnerLocal, buildOwnerLegacyWorkspaceBackup } from '@/utils/owner-workspace-backup'
import { buildOwnerPortfolioRecoveryBackup } from '@/utils/owner-portfolio-recovery'
import type { OwnerSyncRecord } from '@/utils/ownerSyncContract'

const TARGET = '3'.repeat(64), KEY = '510300::总预算审查合成账户', handles: OwnerWorkspace[] = []
afterEach(() => { handles.splice(0).forEach(handle => handle.close()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function fund(shares = 0, revision = 1): OwnerSyncRecord {
  return { key: KEY, kind: 'holding', deleted: false, record_revision: revision, lifecycle_revision: 1,
    field_revisions: { name: 1, shares: revision, cost: 1, target_weight: 1 },
    values: { name: '预算审查合成基金', shares, cost: null, target_weight: null } }
}
async function workspace() {
  const factory = new IDBFactory(), authority = new AbortController(), guard: OwnerWorkspaceGuard = {
    signal: authority.signal, assertActive() { if (authority.signal.aborted) throw new Error('synthetic authority revoked') },
  }, v3 = await openOwnerWorkspace(factory, TARGET); handles.push(v3)
  const sourceArchive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: null, v2Raw: canonicalOwnerLocal([
    { code: '510300', name: '预算审查合成基金', account: '总预算审查合成账户', position_kind: 'holding', shares: 0,
      cost: null, target_weight: null, updated_at: '2026-10-24T00:00:00Z' },
  ]) }, backup = await buildOwnerLegacyWorkspaceBackup(sourceArchive), adopted = await v3.adoptLocal(await buildOwnerWorkspaceAdoptLocalRequest(TARGET,
    { id: 'fullreview-adopt-0001', expected: await v3.readLocalState(guard), sourceArchive, backupSha256: backup.sha256 }), guard),
    v4 = await upgradeOwnerWorkspaceSync(factory, TARGET, adopted, guard); handles.push(v4)
  await v4.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'fullreview-old-link-0001', expected: await v4.readSyncState(guard),
    base: { pulledRevision: 1, records: [fund()] } }), guard)
  const portfolio = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, await v4.readLocalState(guard), { manualRaw: null, snapshotsRaw: null }),
    v5 = await upgradeOwnerWorkspacePortfolio(factory, TARGET, await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET,
      { id: 'fullreview-portfolio-0001', backupRaw: portfolio.raw, backupSha256: portfolio.sha256 }), guard); handles.push(v5)
  const backup5 = await buildOwnerPortfolioRecoveryBackup(TARGET, await v5.readLocalState(guard)),
    v6 = await upgradeOwnerWorkspaceFullSync(factory, TARGET, await buildOwnerWorkspaceFullSyncUpgradeRequest(TARGET,
      { id: 'fullreview-upgrade-0001', backupRaw: backup5.raw, backupSha256: backup5.sha256 }), guard); handles.push(v6)
  const linked = await v6.linkFullSyncBase(await buildOwnerWorkspaceFullSyncLinkRequest(TARGET, { id: 'fullreview-full-link-0001', expected: await v6.readFullSyncState(guard),
    base: { pulledRevision: 1, records: [fund()] }, minimumObservedRevision: 1, resolutions: [] }), guard)
  await v6.editLocal(await buildOwnerWorkspaceEditLocalRequest(TARGET, { id: 'fullreview-edit-0001', expected: linked.local,
    command: { type: 'save', expectedEntry: linked.local.snapshot.entries[0], confirmed: true,
      input: { code: '510300', name: '预算审查合成基金', account: '总预算审查合成账户', position_kind: 'holding', shares: 7,
        cost: null, target_weight: null } } }), guard)
  return { v6, guard }
}

describe('whole-operation budget includes actual session and authority capture', () => {
  it.each(['session', 'guard'] as const)('never starts real attempted/POST when synchronous %s capture already used the total 12s', async phase => {
    const current = await workspace(), write = vi.fn(async () => ({ status: 200, rawBody: JSON.stringify({ revision: 2, records: [fund(7, 2)] }) }))
    let now = 100, enabled = false, consumed = false
    function capture(stage: typeof phase) {
      if (enabled && !consumed && phase === stage) { consumed = true; now += 12_000 }
    }
    const managed = createOwnerPortfolioWorkspaceSync({ workspace: current.v6,
      transport: { targetFingerprint: TARGET, write, receipt: vi.fn(), changes: vi.fn() },
      session: () => { capture('session'); return { authenticated: true, generation: 1 } },
      guard: () => { capture('guard'); return current.guard },
    })
    managed.setCloudConsent(true); await managed.hydrate()
    const request = await managed.previewPreparation('fullreview-prepare-0001')
    await managed.commitPreparation(request, true)
    const before = await current.v6.readFullSyncState(current.guard)
    vi.spyOn(globalThis.performance, 'now').mockImplementation(() => now); enabled = true
    const error = await managed.sendOnce().then(() => null, problem => problem as unknown)
    expect(consumed).toBe(true)
    expect(write).not.toHaveBeenCalled()
    expect(await current.v6.readFullSyncState(current.guard)).toEqual(before)
    expect(error).toMatchObject({ code: 'managed_timeout' })
    managed.close()
  })
  it.each(['session', 'guard'] as const)('rejects clock rollback inside synchronous %s capture before any real attempted/POST', async phase => {
    const current = await workspace(), write = vi.fn(async () => ({ status: 200, rawBody: JSON.stringify({ revision: 2, records: [fund(7, 2)] }) }))
    let now = 100, enabled = false, consumed = false
    function capture(stage: typeof phase) { if (enabled && !consumed && stage === phase) { consumed = true; now = 99 } }
    const managed = createOwnerPortfolioWorkspaceSync({ workspace: current.v6,
      transport: { targetFingerprint: TARGET, write, receipt: vi.fn(), changes: vi.fn() },
      session: () => { capture('session'); return { authenticated: true, generation: 1 } },
      guard: () => { capture('guard'); return current.guard },
    })
    managed.setCloudConsent(true); await managed.hydrate()
    const request = await managed.previewPreparation('fullreview-clock-rollback-prepare')
    await managed.commitPreparation(request, true)
    const before = await current.v6.readFullSyncState(current.guard)
    vi.spyOn(globalThis.performance, 'now').mockImplementation(() => now); enabled = true
    await expect(managed.sendOnce()).rejects.toMatchObject({ code: 'managed_timeout' })
    expect(consumed).toBe(true); expect(write).not.toHaveBeenCalled()
    expect(await current.v6.readFullSyncState(current.guard)).toEqual(before)
    managed.close()
  })
  it.each([NaN, Infinity, -Infinity])('rejects a nonfinite budget start %s without reading, attempting or sending the original', async start => {
    const current = await workspace(), write = vi.fn(async () => ({ status: 200, rawBody: JSON.stringify({ revision: 2, records: [fund(7, 2)] }) })),
      read = vi.fn((guard: OwnerWorkspaceGuard) => current.v6.readFullSyncState(guard)),
      port = { targetFingerprint: TARGET, readFullSyncState: read, prepareFullSync: current.v6.prepareFullSync,
        cancelPreparedFullSync: current.v6.cancelPreparedFullSync, transitionFullSyncDelivery: current.v6.transitionFullSyncDelivery,
        ackFullSync: current.v6.ackFullSync, refreshFullSync: current.v6.refreshFullSync, fullSyncReceipt: current.v6.fullSyncReceipt },
      managed = createOwnerPortfolioWorkspaceSync({ workspace: port,
        transport: { targetFingerprint: TARGET, write, receipt: vi.fn(), changes: vi.fn() },
        session: () => ({ authenticated: true, generation: 1 }), guard: () => current.guard })
    managed.setCloudConsent(true); await managed.hydrate()
    const request = await managed.previewPreparation('fullreview-nonfinite-start-prepare')
    await managed.commitPreparation(request, true)
    const before = await current.v6.readFullSyncState(current.guard), reads = read.mock.calls.length
    vi.spyOn(globalThis.performance, 'now').mockReturnValue(start)
    await expect(managed.sendOnce()).rejects.toMatchObject({ code: 'managed_timeout' })
    expect(write).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(reads)
    expect(await current.v6.readFullSyncState(current.guard)).toEqual(before)
    managed.close()
  })
})
