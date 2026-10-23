/** Explicit source-bound analysis workflow. No default app, storage or token. */
import { withRequestDeadline } from '@/api/request'
import type { OwnerAnalysisTransport } from '@/api/owner-analysis-transport'
import type { OwnerSyncCandidateTransport, OwnerSyncBaseline } from './ownerSyncCandidate'
import type { OwnerAnalysisLocalSource } from './watchlist'
import type { OwnerAnalysisOutbox, OwnerAnalysisTaskSlot } from './owner-analysis-outbox'
import { canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { validateOwnerWorkspaceCloudBaseline } from '@/utils/owner-workspace-sync-baseline'
import { compareSyncKeys, parseSyncChangesPage, type OwnerSyncCursor, type OwnerSyncRecord } from '@/utils/ownerSyncContract'
import { buildOwnerAnalysisRequest, restoreOwnerAnalysisRequest, parseOwnerAnalysisWriteResponse,
  parseOwnerAnalysisReceiptResponse, parseOwnerAnalysisPolicy, parseOwnerAnalysisEvidence,
  type BuiltOwnerAnalysisRequest, type OwnerAnalysisResult } from '@/utils/ownerAnalysisContract'
import type { V8EvidenceSnapshot, V8PortfolioPolicy } from '@/api/client'

export interface OwnerAnalysisPreview {
  readonly packet: BuiltOwnerAnalysisRequest
  readonly policy: V8PortfolioPolicy
  readonly evidence: readonly V8EvidenceSnapshot[]
  readonly records: readonly OwnerSyncRecord[]
}
export interface OwnerAnalysisView {
  readonly busy: boolean
  readonly slot: OwnerAnalysisTaskSlot | null
  readonly preview: OwnerAnalysisPreview | null
  readonly result: OwnerAnalysisResult | null
  readonly qualifiedAt: number | null
  readonly message: string
}
export class OwnerAnalysisWorkflowError extends Error {
  constructor() { super('Analysis workflow requires a fresh explicit verification'); this.name = 'OwnerAnalysisWorkflowError' }
}
function fail(): never { throw new OwnerAnalysisWorkflowError() }
const same = (a: unknown, b: unknown) => canonicalOwnerLocal(a) === canonicalOwnerLocal(b)
const ordered = (records: readonly OwnerSyncRecord[]) => [...records].sort((a, b) => compareSyncKeys(a.key, b.key))
async function digest(raw: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function createOwnerAnalysisManager(options: {
  outbox: OwnerAnalysisOutbox
  transport: OwnerAnalysisTransport
  sync: OwnerSyncCandidateTransport
  source(signal: AbortSignal): Promise<OwnerAnalysisLocalSource>
  session(): { authenticated: boolean; generation: number }
  /** Exact configured URL, not just a hash. Rechecked at every boundary. */
  endpoint(): string
  changed(): void
  now?: () => number
}) {
  const target = options.transport.targetFingerprint, endpoint = options.endpoint()
  const ownerGeneration = options.session().generation
  if (target !== options.outbox.targetFingerprint || target !== options.sync.targetFingerprint) fail()
  const clock = options.now ?? Date.now
  let epoch = 0, disposed = false, active: AbortController | null = null
  let slot: OwnerAnalysisTaskSlot | null = null, preview: OwnerAnalysisPreview | null = null
  let previewSource: OwnerAnalysisLocalSource | null = null, previewHash = ''
  let result: OwnerAnalysisResult | null = null, qualifiedAt: number | null = null
  let qualificationSource: OwnerAnalysisLocalSource | null = null, matchedHash = '', message = ''
  // A legal page is an observed head even if later pages/local checks fail.
  // Keep this session's lower bound across invalidations; it is not complete D.
  let latestObservedHead = 0
  const changed = () => options.changed()
  function invalidate() {
    epoch++; active?.abort(); preview = null; previewSource = null; previewHash = ''
    result = null; qualifiedAt = null; qualificationSource = null; matchedHash = ''; message = ''; changed()
  }
  function close() { invalidate(); disposed = true; options.outbox.close() }
  async function run(work: (signal: AbortSignal, check: () => void) => Promise<void>, timeout = 30_000) {
    if (disposed || active) fail()
    const session = options.session(), captured = epoch, controller = new AbortController()
    if (!session.authenticated || !Number.isSafeInteger(session.generation) || session.generation !== ownerGeneration) fail()
    active = controller; changed()
    try {
      await withRequestDeadline(async (signal, ensure) => {
        const check = () => {
          ensure()
          const current = options.session()
          if (disposed || captured !== epoch || !current.authenticated || current.generation !== session.generation
            || options.endpoint() !== endpoint) fail()
        }
        try { check(); await work(signal, check); check() }
        catch (error) { controller.abort(); throw error }
      }, controller.signal, timeout)
    } catch (error) {
      result = null; qualifiedAt = null; qualificationSource = null
      message = slot?.task?.state === 'attempted' ? '提交结果未知。原请求已保留，只能核对原回执、导出或关闭。'
        : '本次核对未完成。请保留原请求，检查登录、同步基线与存储后手动核对。'
      throw error
    } finally { if (active === controller) active = null; changed() }
  }
  async function complete(signal: AbortSignal, check: () => void, floor: number): Promise<OwnerSyncBaseline> {
    let upper: number | undefined, cursor: OwnerSyncCursor | undefined, bytes = 0, count = 0
    const records = new Map<string, OwnerSyncRecord>()
    for (let index = 0; index < 501; index++) {
      const parameters = { sinceRevision: 0, limit: 200, ...(upper === undefined ? {} : { upperRevision: upper }),
        ...(cursor === undefined ? {} : { cursor }) }
      check(); const response = await options.sync.changes(parameters, signal); check()
      bytes += new TextEncoder().encode(response.rawBody).byteLength
      if (response.status !== 200 || bytes > 4 * 1024 * 1024) fail()
      const page = parseSyncChangesPage(response.rawBody, parameters)
      if (page.upper_revision < Math.max(floor, latestObservedHead)) fail()
      latestObservedHead = Math.max(latestObservedHead, page.upper_revision)
      upper = page.upper_revision
      count += page.changes.length
      if (count > 100_000) fail()
      // This endpoint is an ordered change log, not a current-record listing.
      // The strict page parser binds revision/key ordering and the fixed upper;
      // later legal revisions replace that key when reconstructing complete D.
      for (const row of page.changes) records.set(row.key, row)
      if (page.complete) return validateOwnerWorkspaceCloudBaseline({ pulledRevision: upper, records: [...records.values()] })
      cursor = page.next_cursor ?? undefined
      if (!cursor) fail()
    }
    return fail()
  }
  async function inputs(codes: readonly string[], signal: AbortSignal, check: () => void) {
    const response = await options.transport.policy(signal); check()
    const policy = parseOwnerAnalysisPolicy(response.rawBody, clock())
    const evidence: V8EvidenceSnapshot[] = new Array(codes.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, codes.length) }, async () => {
      for (;;) {
        check(); const index = next++; if (index >= codes.length) return
        const response = await options.transport.evidence(codes[index], signal); check()
        evidence[index] = parseOwnerAnalysisEvidence(response.rawBody, codes[index], clock()); check()
      }
    }))
    check(); return { policy, evidence }
  }
  async function source(signal: AbortSignal, check: () => void) {
    const local = await options.source(signal); check(); local.assertActive()
    if (local.targetFingerprint !== target || !local.state.sync.base) fail()
    const cloud = await complete(signal, check, local.state.sync.base.pulledRevision)
    if (cloud.pulledRevision !== local.state.sync.base.pulledRevision
      || !same(ordered(cloud.records), ordered(local.state.sync.base.records))) fail()
    await local.verify(signal); check(); local.assertActive()
    return { local, cloud }
  }
  async function packetFor(current: OwnerAnalysisTaskSlot) {
    if (!current.task) return fail()
    return restoreOwnerAnalysisRequest(current.task.rawBody, current.task.requestHash)
  }
  async function verifySlot(expected: OwnerAnalysisTaskSlot, signal: AbortSignal, check: () => void) {
    const current = await options.outbox.read(signal); check()
    if (!same(expected, current)) fail()
    return current
  }
  async function qualify(value: OwnerAnalysisResult, task: NonNullable<OwnerAnalysisTaskSlot['task']>, signal: AbortSignal, check: () => void) {
    result = value; qualifiedAt = null; qualificationSource = null
    if (!value.source_current) { message = '原回执已核对，持仓来源已有变化；本轮只保留历史记录。'; return }
    const { local, cloud } = await source(signal, check)
    const contextHash = await digest(local.preimage); check(); local.assertActive()
    if (contextHash !== task.contextHash || cloud.pulledRevision !== value.run.source.revision
      || cloud.records.length !== value.run.source.record_count) {
      message = '原回执已核对，本机或完整持仓来源已变化；不能作为当前行动。'; return
    }
    const current = await inputs(value.run.components.map(row => row.code), signal, check)
    if (current.policy.policy_version !== value.run.policy.policy_version
      || current.evidence.some((row, index) => row.evidence_id !== value.run.components[index].evidence.evidence_id)) {
      message = '原回执已核对，策略或证据已有更新；请另行预览新的分析。'; return
    }
    await local.verify(signal); check(); local.assertActive()
    await verifySlot(slot!, signal, check)
    qualificationSource = local; qualifiedAt = clock()
    message = '完整来源、原回执和当前策略/证据已核对。基金权重不含手工资产，金融门禁仍逐项检查。'
  }
  async function receive(value: OwnerAnalysisResult, packet: BuiltOwnerAnalysisRequest, signal: AbortSignal, check: () => void) {
    const current = await verifySlot(slot!, signal, check)
    if (current.task?.requestHash !== packet.requestHash) fail()
    if (current.task.state === 'attempted') {
      slot = await options.outbox.compareAndSwap(current, { ...current.task, state: 'matched' }, signal); check()
    } else if (current.task.state !== 'matched') fail()
    matchedHash = packet.requestHash
    await qualify(value, slot!.task!, signal, check)
  }
  return Object.freeze({
    invalidate, close,
    view(): OwnerAnalysisView {
      const session = options.session(), visible = !disposed && session.authenticated && session.generation === ownerGeneration
        && options.endpoint() === endpoint
      return Object.freeze(visible ? { busy: active !== null, slot, preview, result, qualifiedAt, message }
        : { busy: false, slot: null, preview: null, result: null, qualifiedAt: null, message: '' })
    },
    isQualified(): boolean {
      const now = clock()
      if (!result || qualifiedAt === null || !qualificationSource || !Number.isFinite(now)
        || !Number.isFinite(qualifiedAt) || now < qualifiedAt || now - qualifiedAt >= 60_000) return false
      try { qualificationSource.assertActive(); return !disposed && options.session().authenticated
        && options.session().generation === ownerGeneration && options.endpoint() === endpoint } catch { return false }
    },
    hydrate: () => run(async (signal, check) => {
      slot = await options.outbox.read(signal); check(); preview = null; previewSource = null
      result = null; qualifiedAt = null; matchedHash = ''
      message = slot.task ? '已读取原任务。刷新或重登后须手动核对原回执，不会自动发送。' : '没有待处理分析任务。'
    }, 12_000),
    preview: (id: string) => run(async (signal, check) => {
      const stored = await options.outbox.read(signal); check()
      if (stored.task && stored.task.state !== 'prepared') fail()
      const { local, cloud } = await source(signal, check)
      const codes = [...new Set(cloud.records.filter(row => !row.deleted && row.kind !== 'manual_asset').map(row => row.key.slice(0, 6)))].sort()
      if (!codes.length || codes.length > 100) fail()
      const refs = await inputs(codes, signal, check)
      const original = stored.task ? await packetFor(stored) : null; check()
      const packet = await buildOwnerAnalysisRequest({ request_id: original?.request.request_id ?? id,
        expected_revision: cloud.pulledRevision, policy_version: refs.policy.policy_version,
        evidence: refs.evidence.map(row => ({ code: row.fund_code, evidence_id: row.evidence_id })) }); check()
      const contextHash = await digest(local.preimage); check()
      if (stored.task && (stored.task.rawBody !== packet.rawBody || stored.task.requestHash !== packet.requestHash
        || stored.task.contextHash !== contextHash)) fail()
      await local.verify(signal); check(); await verifySlot(stored, signal, check)
      slot = stored; previewSource = local; previewHash = contextHash
      preview = Object.freeze({ packet, ...refs, records: cloud.records })
      result = null; qualifiedAt = null; message = '请逐项核对完整持仓、策略与证据，再保存原包；尚未发送分析。'
    }),
    prepare: (confirmed: true) => run(async (signal, check) => {
      if (confirmed !== true || !preview || !previewSource || !slot || slot.task) fail()
      await previewSource.verify(signal); check(); await verifySlot(slot, signal, check)
      slot = await options.outbox.compareAndSwap(slot, { state: 'prepared', rawBody: preview.packet.rawBody,
        requestHash: preview.packet.requestHash, contextHash: previewHash }, signal); check()
      message = '原包已保存，尚未发送。请另行确认一次发送。'
    }, 12_000),
    sendOnce: (confirmed: true) => run(async (signal, check) => {
      if (confirmed !== true || !preview || !previewSource || !slot?.task || slot.task.state !== 'prepared') fail()
      await previewSource.verify(signal); check()
      const current = await verifySlot(slot, signal, check)
      if (current.task!.rawBody !== preview.packet.rawBody || current.task!.contextHash !== previewHash) fail()
      // Commit the marker before transfer. A cancellation/CAS lost response
      // leaves an original task to inspect, never an invitation to send again.
      slot = await options.outbox.compareAndSwap(current, { ...current.task!, state: 'attempted' }, signal); check()
      previewSource.assertActive()
      const packet = preview.packet, response = await options.transport.write(packet, signal); check()
      const parsed = parseOwnerAnalysisWriteResponse(response.status, response.rawBody, packet, clock())
      if (parsed.kind !== 'success') fail()
      await receive(parsed.result, packet, signal, check)
      preview = null; previewSource = null
    }),
    reconcile: () => run(async (signal, check) => {
      if (!slot?.task || slot.task.state === 'prepared') fail()
      await verifySlot(slot, signal, check)
      const packet = await packetFor(slot); check()
      const response = await options.transport.receipt(packet, signal); check()
      const parsed = parseOwnerAnalysisReceiptResponse(response.status, response.rawBody, packet, clock())
      if (!('state' in parsed) || parsed.state !== 'matched') fail()
      await receive(parsed.result, packet, signal, check)
    }),
    cancelPrepared: (confirmed: true) => run(async (signal, check) => {
      if (confirmed !== true || !slot?.task || slot.task.state !== 'prepared') fail()
      await verifySlot(slot, signal, check)
      slot = await options.outbox.compareAndSwap(slot, null, signal); check()
      preview = null; previewSource = null; message = '已取消尚未发送的原包。'
    }, 12_000),
    finishMatched: (confirmed: true) => run(async (signal, check) => {
      if (confirmed !== true || !slot?.task || slot.task.state !== 'matched' || slot.task.requestHash !== matchedHash) fail()
      await verifySlot(slot, signal, check)
      slot = await options.outbox.compareAndSwap(slot, null, signal); check()
      matchedHash = ''; message = '已结束本轮任务。刷新后不再猜测或自动发现这份历史分析。'
    }, 12_000),
    exportTask: () => {
      if (!slot?.task || disposed || !options.session().authenticated || options.session().generation !== ownerGeneration
        || options.endpoint() !== endpoint) fail()
      return Object.freeze({ schema: 'sinan-owner-analysis-task-1', targetFingerprint: target,
        task: slot.task, version: slot.version })
    },
  })
}
export type OwnerAnalysisManager = ReturnType<typeof createOwnerAnalysisManager>
