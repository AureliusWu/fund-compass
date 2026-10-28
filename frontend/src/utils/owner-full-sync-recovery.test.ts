/** Actual adopted/v4/v5/v6 core chain with synthetic records. File decode is
 * not a database restore, browser download, PWA replacement or cloud proof. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import type { OwnerSyncBaseline } from '@/stores/ownerSyncCandidate'
import {
  openOwnerWorkspace, upgradeOwnerWorkspaceSync, upgradeOwnerWorkspacePortfolio, upgradeOwnerWorkspaceFullSync,
  buildOwnerWorkspaceAdoptLocalRequest, buildOwnerWorkspaceRestoreLocalRequest, buildOwnerWorkspaceLinkCloudRequest,
  buildOwnerWorkspaceFullSyncLinkRequest, buildOwnerWorkspaceEditPortfolioRequest,
  type OwnerWorkspace, type OwnerWorkspaceGuard,
} from '@/stores/owner-workspace'
import { buildOwnerWorkspacePortfolioUpgradeBackup, buildOwnerWorkspacePortfolioUpgradeRequest } from '@/stores/owner-workspace-portfolio-upgrade'
import { buildOwnerWorkspaceFullSyncUpgradeRequest } from '@/stores/owner-workspace-full-sync-upgrade'
import { buildOwnerPortfolioRecoveryBackup, restoreOwnerPortfolioRecoveryBackup } from './owner-portfolio-recovery'
import { buildOwnerLegacyWorkspaceBackup, canonicalOwnerLocal } from './owner-workspace-backup'
import { parseOwnerBusinessJson } from './owner-legacy-seed'
import { previewOwnerPortfolioInitialMerge } from './owner-portfolio-merge'
import { restoreOwnerWorkspaceRecoveryBackup } from './owner-workspace-recovery'
import {
  OWNER_FULL_SYNC_RECOVERY_FORMAT, OWNER_FULL_SYNC_RECOVERY_MAX_BYTES,
  buildOwnerFullSyncRecoveryBackup, restoreOwnerFullSyncRecoveryBackup, validateOwnerFullSyncRecoveryBackup,
} from './owner-full-sync-recovery'

const TARGET = '4'.repeat(64), KEY = '510300::全备份合成账户', OTHER = '000002::全备份合成账户'
const handles: OwnerWorkspace[] = []
const hash = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex')
afterEach(() => { handles.splice(0).forEach(handle => handle.close()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function fixture(linked = false) {
  const factory = new IDBFactory(), controller = new AbortController()
  const guard: OwnerWorkspaceGuard = { signal: controller.signal, assertActive() { if (controller.signal.aborted) throw new Error('revoked') } }
  const v3 = await openOwnerWorkspace(factory, TARGET); handles.push(v3)
  const archive = { sourceKey: 'sinan_watchlist_v2' as const, v1Raw: 'original opaque private archive',
    v2Raw: canonicalOwnerLocal([{ code: '510300', name: '合成零份', account: '全备份合成账户', position_kind: 'holding',
      shares: -0, cost: null, target_weight: 0, updated_at: '2026-10-24T00:00:00Z' }]) }
  const original = await buildOwnerLegacyWorkspaceBackup(archive)
  await v3.adoptLocal(await buildOwnerWorkspaceAdoptLocalRequest(TARGET, { id: 'full-recovery-adopt-0001',
    expected: await v3.readLocalState(guard), sourceArchive: archive, backupSha256: original.sha256 }), guard)
  const extra = await buildOwnerLegacyWorkspaceBackup({ sourceKey: 'sinan_watchlist_v2', v1Raw: null,
    v2Raw: canonicalOwnerLocal([{ code: '000002', name: '合成归档关注', account: '全备份合成账户', position_kind: 'watch',
      shares: null, cost: null, target_weight: null, updated_at: '2026-10-23T01:00:00Z' }]) })
  const v3State = await v3.restoreLocal(await buildOwnerWorkspaceRestoreLocalRequest(TARGET, { id: 'full-recovery-archive-0001',
    expected: await v3.readLocalState(guard), backup: extra.envelope }), guard)
  const v4 = await upgradeOwnerWorkspaceSync(factory, TARGET, v3State, guard); handles.push(v4)
  const cloud: OwnerSyncBaseline = { pulledRevision: 3, records: [
    { key: KEY, kind: 'holding' as const, deleted: false, record_revision: 3, lifecycle_revision: 1,
      field_revisions: { name: 1, shares: 3, cost: 1, target_weight: 1 },
      values: { name: '合成零份', shares: -0, cost: null, target_weight: 0 } },
    { key: OTHER, kind: 'watch' as const, deleted: false, record_revision: 2, lifecycle_revision: 2,
      field_revisions: { name: 2, shares: 2, cost: 2, target_weight: 2 },
      values: { name: '合成归档关注', shares: null, cost: null, target_weight: null } },
    { key: 'asset:remote-tombstone', kind: 'manual_asset' as const, deleted: true, record_revision: 2, lifecycle_revision: 2,
      field_revisions: { name: 1, cls: 1, value: 2, note: 1 }, values: { name: '旧云现金', cls: '现金', value: -0, note: null } },
  ] }
  await v4.linkCloudBase(await buildOwnerWorkspaceLinkCloudRequest(TARGET, { id: 'full-recovery-old-link-0001', expected: await v4.readSyncState(guard), base: cloud }), guard)
  const v4State = await v4.readLocalState(guard)
  const source = { manualRaw: ' \n' + canonicalOwnerLocal([
    { id: 'x'.repeat(200), name: '合成零余额', cls: '现金', value: -0, updated_at: '2026-10-24T23:00:00Z' },
    { id: 'synthetic-gold', name: '合成商品', cls: '商品', value: 3, note: '', updated_at: '2026-10-24T23:00:00.12Z' },
  ]) + '\r\n', snapshotsRaw: canonicalOwnerLocal([
    { date: '2026-10-24', value: -0, cost: 0 },
    { date: '2026-10-24', value: 7, cost: 9, holdings: [{ id: 'opaque|not-current-identity', code: 'old-code',
      name: '旧持仓', account: '旧账户', type: '旧类别', value: 7, cost: 9 }] },
  ]) }
  const portfolioFile = await buildOwnerWorkspacePortfolioUpgradeBackup(TARGET, v4State, source)
  const portfolioUpgrade = await buildOwnerWorkspacePortfolioUpgradeRequest(TARGET, { id: 'full-recovery-portfolio-0001', backupRaw: portfolioFile.raw, backupSha256: portfolioFile.sha256 })
  const v5 = await upgradeOwnerWorkspacePortfolio(factory, TARGET, portfolioUpgrade, guard); handles.push(v5)
  const v5State = await v5.readLocalState(guard), upgradeFile = await buildOwnerPortfolioRecoveryBackup(TARGET, v5State)
  const upgrade = await buildOwnerWorkspaceFullSyncUpgradeRequest(TARGET, { id: 'full-recovery-upgrade-0001', backupRaw: upgradeFile.raw, backupSha256: upgradeFile.sha256 })
  const v6 = await upgradeOwnerWorkspaceFullSync(factory, TARGET, upgrade, guard); handles.push(v6)
  if (linked) {
    const complete = { ...cloud, pulledRevision: 4, records: [...cloud.records, ...v5State.portfolio!.manual.map(row => ({ key: row.key,
      kind: 'manual_asset' as const, deleted: row.deleted, record_revision: 4, lifecycle_revision: 4,
      field_revisions: { name: 4, cls: 4, value: 4, note: 4 }, values: { ...row.values } }))] }
    const check = previewOwnerPortfolioInitialMerge({ base: v5State.sync!.base!, localSnapshot: v5State.snapshot,
      portfolio: v5State.portfolio!, completeBaseline: complete, minimumObservedRevision: 3, resolutions: [] })
    expect({ issues: check.issues, conflicts: check.conflicts }).toEqual({ issues: [], conflicts: [] })
    await v6.linkFullSyncBase(await buildOwnerWorkspaceFullSyncLinkRequest(TARGET, { id: 'full-recovery-link-0001',
      expected: await v6.readFullSyncState(guard), base: complete, minimumObservedRevision: 3, resolutions: [] }), guard)
  }
  const current = await v6.readLocalState(guard)
  await v6.editPortfolio(await buildOwnerWorkspaceEditPortfolioRequest(TARGET, { id: 'full-recovery-observation-0001', expected: current,
    command: { type: 'append_observation', observation: { id: 'full-recovery-balance-0001', kind: 'observation',
      observed_at: '2026-10-24T16:00:00Z', date: '2026-10-25', calendar: 'Asia/Shanghai', value: 3, cost: null,
      holdings: [{ kind: 'fund', key: KEY, name: '合成零份', type: '指数型', value: -0, cost: null },
        ...current.portfolio!.manual.filter(row => !row.deleted).map(row => ({ kind: 'manual' as const, key: row.key,
          name: row.values.name, cls: row.values.cls, value: row.values.value, cost: null }))] } } }), guard)
  return { factory, guard, v3State, v4State, v5State, state: await v6.readLocalState(guard), cloud, source, portfolioFile, upgradeFile, upgrade }
}
function copy<T>(input: T): T { return parseOwnerBusinessJson(canonicalOwnerLocal(input), OWNER_FULL_SYNC_RECOVERY_MAX_BYTES, 12) as T }

describe('complete physical-v6 recovery3 file', () => {
  it.each([false, true])('roundtrips the actual complete v6 linked=%s image with every archive, intent, history and signed zero', async linked => {
    const current = await fixture(linked), forbidden = vi.fn(() => { throw new Error('ambient IO forbidden') })
    vi.stubGlobal('fetch', forbidden); vi.stubGlobal('indexedDB', { open: forbidden }); vi.stubGlobal('localStorage', { getItem: forbidden })
    const built = await buildOwnerFullSyncRecoveryBackup(TARGET, current.state)
    expect(built.envelope).toEqual({ format: OWNER_FULL_SYNC_RECOVERY_FORMAT, physicalVersion: 6, targetFingerprint: TARGET, local: current.state })
    expect(built.sha256).toBe(hash(built.raw)); expect(built.byteLength).toBe(Buffer.byteLength(built.raw, 'utf8'))
    const recovered = await restoreOwnerFullSyncRecoveryBackup(built.raw, built.sha256)
    expect(recovered).toEqual(built.envelope)
    expect(recovered.local.metadata.restoredArchives).toHaveLength(1); expect(recovered.local.sync!.base).toEqual(current.cloud)
    expect(recovered.local.fullSync!.base === null).toBe(!linked)
    expect(recovered.local.fullSyncUpgrade!.backupSha256).toBe(current.upgradeFile.sha256)
    expect(recovered.local.portfolioUpgrade!.backupSha256).toBe(current.portfolioFile.sha256)
    expect(recovered.local.portfolio!.migration.manualRaw).toBe(current.source.manualRaw)
    expect(recovered.local.portfolio!.migration.snapshotsRaw).toBe(current.source.snapshotsRaw)
    expect(recovered.local.portfolio!.history.map(item => item.date)).toEqual(['2026-10-24', '2026-10-24', '2026-10-25'])
    expect(recovered.local.portfolio!.history.map(item => item.cost)).toEqual([0, 9, null])
    expect(recovered.local.portfolio!.history[1].holdings![0]).toMatchObject({ id: 'opaque|not-current-identity' })
    expect(Object.is(recovered.local.snapshot.entries[0].values.shares, -0)).toBe(true)
    expect(Object.is(recovered.local.portfolio!.manual[0].values.value, -0)).toBe(true)
    expect(Object.is(recovered.local.portfolio!.history[0].value, -0)).toBe(true)
    expect(recovered.local.portfolio!.manual[0].values.note).toBeNull()
    expect(Object.isFrozen(recovered.local.portfolio!.history[2].holdings![0])).toBe(true)
    expect(Object.isFrozen(recovered.local.fullSyncUpgrade)).toBe(true); expect(forbidden).not.toHaveBeenCalled()
  })
  it('owns the complete input before the first async hash or validator', async () => {
    const current = await fixture(), input = copy(current.state) as any
    const pending = buildOwnerFullSyncRecoveryBackup(TARGET, input)
    input.portfolio.manual[1].values.value = 999; input.fullSyncUpgrade.id = 'changed-after-call-0001'
    input.metadata.adoption.sourceArchive.v1Raw = 'changed after call'
    const built = await pending
    expect(built.envelope.local.portfolio!.manual[1].values.value).toBe(3)
    expect(built.envelope.local.fullSyncUpgrade!.id).toBe(current.upgrade.id)
    expect(built.envelope.local.metadata.adoption!.sourceArchive.v1Raw).toBe(current.state.metadata.adoption!.sourceArchive.v1Raw)
  })
  it('keeps recovery1/recovery2/v6 formats closed in both directions', async () => {
    const current = await fixture()
    for (const old of [current.v3State, current.v4State, current.v5State]) {
      await expect(buildOwnerFullSyncRecoveryBackup(TARGET, old)).rejects.toMatchObject({ code: 'invalid_recovery' })
    }
    const built = await buildOwnerFullSyncRecoveryBackup(TARGET, current.state)
    await expect(restoreOwnerWorkspaceRecoveryBackup(built.raw, built.sha256)).rejects.toBeInstanceOf(Error)
    await expect(restoreOwnerPortfolioRecoveryBackup(built.raw, built.sha256)).rejects.toBeInstanceOf(Error)
    const old = await buildOwnerPortfolioRecoveryBackup(TARGET, current.v5State)
    await expect(restoreOwnerFullSyncRecoveryBackup(old.raw, old.sha256)).rejects.toMatchObject({ code: 'invalid_recovery' })
    for (const physicalVersion of [3, 4, 5]) {
      const raw = canonicalOwnerLocal({ ...built.envelope, physicalVersion })
      await expect(restoreOwnerFullSyncRecoveryBackup(raw, hash(raw))).rejects.toMatchObject({ code: 'invalid_recovery' })
    }
  })
  it('rejects resealed corruption of old and new fields, including original adoption/source/intent hashes', async () => {
    const current = await fixture(true), built = await buildOwnerFullSyncRecoveryBackup(TARGET, current.state)
    const faults: Array<(input: any) => void> = [
      input => { input.local.fullSync.profile = 'fund-only-1' }, input => { input.local.fullSyncUpgrade.hash = 'a'.repeat(64) },
      input => { input.local.fullSyncUpgrade.backupSha256 = 'a'.repeat(64) }, input => { delete input.local.fullSyncUpgrade },
      input => { input.local.fullSync.targetFingerprint = 'a'.repeat(64) },
      input => { input.local.fullSync.base.records = input.local.fullSync.base.records.filter((row: any) => row.record_revision !== 4) },
      input => { input.local.fullSync.base.pulledRevision = 2 }, input => { input.local.fullSync.recentReceipt.syncEpoch = 0 },
      input => { input.local.portfolio.migration.sourceSha256 = 'a'.repeat(64) }, input => { input.local.portfolioUpgrade.hash = 'a'.repeat(64) },
      input => { input.local.portfolio.manual.shift() }, input => { input.local.portfolio.history.shift() },
      input => { input.local.portfolio.history[1].holdings[0].id = 'changed opaque id' },
      input => { input.local.metadata.adoption.backupSha256 = 'a'.repeat(64) }, input => { input.local.receiptCount = 1 },
      input => { delete input.local.sync }, input => { delete input.local.portfolioUpgrade },
      input => { input.local.sync.pending = {} }, input => { input.token = 'not-a-token' },
      input => { input.local.analysisTask = 'not-part-of-file' },
    ]
    for (const mutate of faults) {
      const input = copy(built.envelope); mutate(input); const raw = canonicalOwnerLocal(input)
      await expect(restoreOwnerFullSyncRecoveryBackup(raw, hash(raw))).rejects.toMatchObject({ code: 'invalid_recovery' })
    }
  })
  it('deliberately refuses nonempty original packets rather than pretending to verify a new full-profile envelope', async () => {
    const current = await fixture(true), built = await buildOwnerFullSyncRecoveryBackup(TARGET, current.state), input: any = copy(built.envelope)
    input.local.outbox = { version: input.local.outbox.version + 1,
      entry: { schema: 'owner-sync-outbox-1', state: 'unknown', rawBody: '{}', requestHash: 'd'.repeat(64) } }
    input.local.fullSync.epoch = 2
    input.local.fullSync.pending = { requestId: 'full-recovery-pending-0001', requestHash: 'd'.repeat(64), rawBody: '{}',
      preimageHash: 'e'.repeat(64), preparationHash: 'f'.repeat(64), adoptionId: input.local.metadata.adoption.id,
      adoptionHash: input.local.metadata.adoption.hash, localVersion: input.local.snapshot.localVersion,
      preparedOutboxVersion: input.local.outbox.version, baseRevision: input.local.fullSync.base.pulledRevision }
    const raw = canonicalOwnerLocal(input)
    await expect(restoreOwnerFullSyncRecoveryBackup(raw, hash(raw))).rejects.toMatchObject({ code: 'invalid_recovery' })
  })
  it.each(['getter', 'hidden', 'symbol', 'prototype', 'array-extra', 'array-hole'] as const)
    ('rejects unsafe nested input %s without reading accessors', async attack => {
      const current = await fixture(), built = await buildOwnerFullSyncRecoveryBackup(TARGET, current.state), value: any = copy(built.envelope), getter = vi.fn()
      if (attack === 'getter') Object.defineProperty(value.local.fullSyncUpgrade, 'id', { get: getter, enumerable: true })
      else if (attack === 'hidden') Object.defineProperty(value.local.portfolio.manual[0], 'hidden', { value: true })
      else if (attack === 'symbol') value.local.metadata[Symbol('private')] = true
      else if (attack === 'prototype') Object.setPrototypeOf(value.local.fullSync, { inherited: true })
      else if (attack === 'array-extra') value.local.portfolio.manual.extra = true
      else delete value.local.portfolio.manual[0]
      await expect(validateOwnerFullSyncRecoveryBackup(value)).rejects.toBeInstanceOf(Error)
      expect(getter).not.toHaveBeenCalled()
    })
  it('rejects changed bytes, BOM, duplicate or escaped keys, unsafe integers and noncanonical whitespace', async () => {
    const current = await fixture(), built = await buildOwnerFullSyncRecoveryBackup(TARGET, current.state)
    await expect(restoreOwnerFullSyncRecoveryBackup(built.raw + '\n', built.sha256)).rejects.toMatchObject({ code: 'hash_mismatch' })
    for (const raw of ['\ufeff' + built.raw, built.raw + '\n', built.raw.replace('{', '{"physicalVersion":6,'),
      built.raw.replace('{', '{"\\u0070hysicalVersion":6,'), built.raw.replace('"receiptCount":0', '"receiptCount":9007199254740993')]) {
      await expect(restoreOwnerFullSyncRecoveryBackup(raw, hash(raw))).rejects.toBeInstanceOf(Error)
    }
    await expect(restoreOwnerFullSyncRecoveryBackup(built.raw, 'bad-sha')).rejects.toMatchObject({ code: 'invalid_recovery' })
    await expect(restoreOwnerFullSyncRecoveryBackup('\ud800', 'a'.repeat(64))).rejects.toMatchObject({ code: 'invalid_recovery' })
  })
  it('enforces the full24MiB UTF8/depth12 bounds without dropping archives or nested fields', async () => {
    for (const raw of [' '.repeat(OWNER_FULL_SYNC_RECOVERY_MAX_BYTES + 1), '界'.repeat(Math.floor(OWNER_FULL_SYNC_RECOVERY_MAX_BYTES / 3) + 1)]) {
      await expect(restoreOwnerFullSyncRecoveryBackup(raw, 'a'.repeat(64))).rejects.toMatchObject({ code: 'capacity_exceeded' })
    }
    let nested: unknown = null
    for (let at = 0; at < 13; at++) nested = { child: nested }
    await expect(validateOwnerFullSyncRecoveryBackup(nested)).rejects.toMatchObject({ code: 'capacity_exceeded' })
  })
  it('rechecks a previously validated intent hash and never substitutes a digest when crypto fails', async () => {
    const current = await fixture(), built = await buildOwnerFullSyncRecoveryBackup(TARGET, current.state)
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('unavailable'))
    await expect(restoreOwnerFullSyncRecoveryBackup(built.raw, built.sha256)).rejects.toMatchObject({ code: 'hash_unavailable' })
  })
})
