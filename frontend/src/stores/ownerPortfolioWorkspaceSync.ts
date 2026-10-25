/** Explicit full fund/manual packet orchestration. Default off, no implicit
 * IO, no fund-only fallback, and no ownership of the shared application DB.
 * The app-owned host binds the actual locator, complete source and consent.
 */
import { createOwnerSyncCandidate, type OwnerSyncCandidateTransport, type OwnerSyncBaseline, type OwnerSyncBoundResult } from './ownerSyncCandidate'
import type { OwnerSyncOutbox, OwnerSyncOutboxSnapshot } from './ownerSyncOutbox'
import { buildOwnerWorkspaceFullSyncPrepareRequest, buildOwnerWorkspaceFullSyncCancelRequest,
  buildOwnerWorkspaceFullSyncAckRequest, previewOwnerWorkspaceFullSyncAck, OwnerWorkspaceError } from './owner-workspace'
import type { OwnerWorkspace, OwnerWorkspaceGuard, OwnerWorkspaceFullSyncState, OwnerWorkspaceFullSyncPrepareRequest,
  OwnerWorkspaceFullSyncDeliveryRequest, OwnerWorkspaceFullSyncAckRequest } from './owner-workspace-types'
import { canonicalOwnerLocal } from '@/utils/owner-workspace-backup'
import { copyOwnerFullSyncInput } from '@/utils/owner-full-sync-input'
import { parseSyncReceiptResponse, parseSyncWriteResponse, parseSyncChangesPage } from '@/utils/ownerSyncContract'
import type { OwnerWorkspaceAckRawMatched } from '@/utils/owner-workspace-ack'
import type { OwnerPortfolioAckResolution } from '@/utils/owner-portfolio-ack'
import { ApiError, withRequestDeadline } from '@/api/request'

type Session = Readonly<{ authenticated: boolean; generation: number }>
type Operation = 'prepare' | 'cancel' | 'ack'
type WorkspacePort = Pick<OwnerWorkspace, 'targetFingerprint' | 'readFullSyncState'
  | 'prepareFullSync' | 'cancelPreparedFullSync' | 'fullSyncReceipt'> & {
  transitionFullSyncDelivery(request: OwnerWorkspaceFullSyncDeliveryRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceFullSyncState>
  ackFullSync(request: OwnerWorkspaceFullSyncAckRequest, guard: OwnerWorkspaceGuard): Promise<OwnerWorkspaceFullSyncState>
}
type Binding = Readonly<{ requestId: string; requestHash: string; preparationHash: string;
  adoptionId: string; adoptionHash: string }>
type Uncertain = Readonly<{ operation: Operation; id: string; hash: string }>
interface Captured {
  epoch: number; generation: number; controller: AbortController; guard: OwnerWorkspaceGuard
  image: OwnerWorkspaceFullSyncState | null; evidence: OwnerWorkspaceAckRawMatched | null
  allowEmpty: boolean
  mutation: Uncertain | null; deadline?: () => void
}
interface Complete {
  baseline: OwnerSyncBaseline; expected: OwnerWorkspaceFullSyncState; epoch: number; generation: number
}
const HASH = /^[0-9a-f]{64}(?![\s\S])/
const TOTAL_MS = 12_000
export class OwnerPortfolioWorkspaceSyncError extends Error {
  constructor(readonly code: 'managed_invalid_options' | 'managed_disabled' | 'managed_signed_out'
    | 'managed_closed' | 'managed_busy' | 'managed_context_changed' | 'managed_timeout'
    | 'managed_pending' | 'managed_hydrate_required' | 'managed_pull_required'
    | 'managed_result_required' | 'managed_confirmation_required' | 'managed_preview_required'
    | 'managed_local_unknown' | 'managed_unavailable') {
    super('Managed complete portfolio sync unavailable'); this.name = 'OwnerPortfolioWorkspaceSyncError'
  }
}
function fail(code: OwnerPortfolioWorkspaceSyncError['code']): never { throw new OwnerPortfolioWorkspaceSyncError(code) }
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value)
  return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(descriptors, key))
    && Object.values(descriptors).every(item => item.enumerable && 'value' in item)
}
function same(left: unknown, right: unknown): boolean { return canonicalOwnerLocal(left) === canonicalOwnerLocal(right) }
/** Walk data descriptors before canonicalization; never execute caller getters.
 * Shared frozen subtrees are legal, cycles and exotic/hidden fields are not.
 */
function nativeData(value: unknown, ancestors = new Set<object>(), budget = { left: 1_000_000 }): boolean {
  if (--budget.left < 0) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || ancestors.has(value)) return false
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value)
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) return false
  if (array && (Object.keys(descriptors).length !== value.length + 1
    || Object.keys(value).some((key, index) => key !== String(index)))) return false
  ancestors.add(value)
  try {
    return Object.entries(descriptors).every(([key, item]) => 'value' in item
      && (array && key === 'length' || item.enumerable) && nativeData(item.value, ancestors, budget))
  } finally { ancestors.delete(value) }
}
function sessionShape(value: unknown): Session {
  if (!closed(value, ['authenticated', 'generation']) || typeof value.authenticated !== 'boolean'
    || typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation)
    || value.generation < 0 || Object.is(value.generation, -0)) fail('managed_context_changed')
  return Object.freeze({ authenticated: value.authenticated, generation: value.generation })
}
function responseShape(value: unknown): { status: number; rawBody: string } {
  if (!closed(value, ['status', 'rawBody']) || typeof value.status !== 'number'
    || !Number.isInteger(value.status) || value.status < 100 || value.status > 599
    || typeof value.rawBody !== 'string' || new TextEncoder().encode(value.rawBody).byteLength > 2_097_152) fail('managed_unavailable')
  return { status: value.status, rawBody: value.rawBody }
}

export function createOwnerPortfolioWorkspaceSync(options: {
  workspace: WorkspacePort
  transport: OwnerSyncCandidateTransport
  session: () => Session
  /** Must create a fresh captured real-authority guard for this operation. */
  guard: (signal: AbortSignal) => OwnerWorkspaceGuard
}) {
  if (!closed(options, ['workspace', 'transport', 'session', 'guard']) || !options.workspace || !options.transport) fail('managed_invalid_options')
  // Capture injected capabilities once. Replacing the caller's options object
  // later must not reroute a pending packet to another port.
  const workspace = options.workspace, configuredTransport = options.transport
  const sessionGetter = options.session, createGuard = options.guard
  const target = workspace.targetFingerprint
  if (typeof target !== 'string' || !HASH.test(target) || target !== configuredTransport.targetFingerprint
    || typeof sessionGetter !== 'function' || typeof createGuard !== 'function') fail('managed_invalid_options')
  let enabled = false, disposed = false, epoch = 0, busy = false
  let seenSession: Session | null = null, active: Captured | null = null
  let binding: Binding | null = null, complete: Complete | null = null
  let matched: OwnerWorkspaceAckRawMatched | null = null, observedFloor = 0
  let uncertain: Uncertain | null = null
  let preview: { operation: 'prepare' | 'ack'; request: OwnerWorkspaceFullSyncPrepareRequest | OwnerWorkspaceFullSyncAckRequest } | null = null
  const readSession = (): Session => {
    try { return sessionShape(sessionGetter()) } catch { return fail('managed_context_changed') }
  }
  function clearViews(): void { binding = null; complete = null; matched = null; preview = null }
  function invalidate(resetHead = false): void {
    epoch++; active?.controller.abort(); clearViews(); candidate.notifySessionChanged()
    if (resetHead) observedFloor = 0
  }
  function checkSession(): Session {
    const current = readSession()
    if (seenSession && !same(current, seenSession)) invalidate(true)
    seenSession = current
    return current
  }
  function assertCurrent(op: Captured): void {
    try { op.deadline?.() } catch (error) {
      if (error instanceof OwnerPortfolioWorkspaceSyncError) throw error
      fail(error instanceof ApiError && error.kind === 'timeout' ? 'managed_timeout' : 'managed_context_changed')
    }
    const session = readSession()
    if (disposed || !enabled || op.controller.signal.aborted || op.epoch !== epoch
      || !session.authenticated || session.generation !== op.generation) fail('managed_context_changed')
    try {
      if (op.guard.signal.aborted) fail('managed_context_changed')
      op.guard.assertActive()
    } catch { fail('managed_context_changed') }
  }
  function guard(op: Captured): OwnerWorkspaceGuard {
    return { signal: op.controller.signal, assertActive: () => assertCurrent(op) }
  }
  function current(): Captured {
    if (!active) fail('managed_context_changed')
    assertCurrent(active); return active
  }
  function pendingBinding(image: OwnerWorkspaceFullSyncState): Binding | null {
    const pending = image.fullSync.pending, adoption = image.local.metadata.adoption
    if (!pending) { if (image.local.outbox.entry) fail('managed_context_changed'); return null }
    if (!adoption || !image.local.outbox.entry) fail('managed_context_changed')
    return Object.freeze({ requestId: pending.requestId, requestHash: pending.requestHash,
      preparationHash: pending.preparationHash, adoptionId: adoption.id, adoptionHash: adoption.hash })
  }
  function verifyBinding(image: OwnerWorkspaceFullSyncState, allowEmpty = false): void {
    const actual = pendingBinding(image)
    if (!actual && allowEmpty) return
    if (actual && (!binding || !same(actual, binding)) || !actual && binding) fail('managed_hydrate_required')
  }
  async function read(op: Captured, allowEmpty = false): Promise<OwnerWorkspaceFullSyncState> {
    assertCurrent(op)
    const image = await workspace.readFullSyncState(guard(op))
    assertCurrent(op); verifyBinding(image, allowEmpty)
    observedFloor = Math.max(observedFloor, image.fullSync.base?.pulledRevision ?? 0)
    op.image = image
    return image
  }
  async function exact(op: Captured, expected: OwnerWorkspaceFullSyncState): Promise<OwnerWorkspaceFullSyncState> {
    const image = await read(op)
    if (!same(image, expected)) fail('managed_context_changed')
    return image
  }
  const outbox: OwnerSyncOutbox = {
    targetFingerprint: target,
    async read(): Promise<OwnerSyncOutboxSnapshot> {
      const op = current(), image = await read(op, op.allowEmpty)
      return image.local.outbox
    },
    async compareAndSwap(expectedVersion, entry): Promise<OwnerSyncOutboxSnapshot> {
      const op = current(), image = await read(op), original = image.local.outbox.entry
      if (!binding || !entry || !original || expectedVersion !== image.local.outbox.version
        || entry.schema !== original.schema || entry.rawBody !== original.rawBody
        || entry.requestHash !== original.requestHash || entry.state === 'prepared') fail('managed_pending')
      const result = await workspace.transitionFullSyncDelivery({ expected: image,
        requestId: binding.requestId, requestHash: binding.requestHash,
        preparationHash: binding.preparationHash, nextState: entry.state }, guard(op))
      assertCurrent(op); verifyBinding(result); op.image = result
      return result.local.outbox
    },
    // Disposal of this adapter never closes a shared application workspace.
    close() { /* no owned IDB handle */ },
  }
  async function forward<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const op = current(), combined = new AbortController()
    const abort = () => combined.abort()
    signal.addEventListener('abort', abort, { once: true })
    op.controller.signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted || op.controller.signal.aborted) combined.abort()
    try {
      assertCurrent(op)
      if (combined.signal.aborted) fail('managed_context_changed')
      const value = await work(combined.signal)
      assertCurrent(op)
      if (combined.signal.aborted) fail('managed_context_changed')
      return value
    } finally {
      signal.removeEventListener('abort', abort); op.controller.signal.removeEventListener('abort', abort)
    }
  }
  const transport: OwnerSyncCandidateTransport = {
    targetFingerprint: target,
    write: (packet, signal) => forward(signal, async combined => {
      const op = current(), expected = op.image
      if (!binding || !expected || packet.requestHash !== binding.requestHash
        || packet.request.request_id !== binding.requestId
        || packet.rawBody !== expected.fullSync.pending?.rawBody) fail('managed_context_changed')
      const image = await exact(op, expected)
      if (image.local.outbox.entry?.state !== 'attempted') fail('managed_pending')
      const response = responseShape(await configuredTransport.write(packet, combined))
      assertCurrent(op)
      op.evidence = Object.freeze({ source: 'write', requestId: binding.requestId, requestHash: binding.requestHash, ...response })
      return response
    }),
    receipt: (requestId, requestHash, signal) => forward(signal, async combined => {
      const op = current()
      if (!binding || requestId !== binding.requestId || requestHash !== binding.requestHash) fail('managed_context_changed')
      await read(op)
      const response = responseShape(await configuredTransport.receipt(requestId, requestHash, combined))
      assertCurrent(op)
      op.evidence = Object.freeze({ source: 'receipt', requestId, requestHash, ...response })
      return response
    }),
    changes: (parameters, signal) => forward(signal, async combined => {
      const op = current(), response = responseShape(await configuredTransport.changes(parameters, combined))
      assertCurrent(op)
      if (response.status === 200) {
        // A strict valid partial page is already an observed server head, not
        // a complete D. Later pages or a local exact-image check may still fail.
        const page = parseSyncChangesPage(response.rawBody, parameters)
        assertCurrent(op)
        observedFloor = Math.max(observedFloor, page.upper_revision)
      }
      return response
    }),
  }
  const candidate = createOwnerSyncCandidate({ outbox, transport, session: readSession })

  async function run<T>(work: (op: Captured) => Promise<T>, allowUncertain = false): Promise<T> {
    // Include synchronous session/authority capture as well as input copying.
    // The deadline must not restart after an expensive host guard capture.
    const started = globalThis.performance.now(); let last = started
    const budget = () => {
      const now = globalThis.performance.now()
      if (!Number.isFinite(started) || !Number.isFinite(now) || now < last || now - started >= TOTAL_MS) fail('managed_timeout')
      last = now; return TOTAL_MS - (now - started)
    }
    let session: Session
    try { session = checkSession() } catch { invalidate(); return fail('managed_context_changed') }
    if (disposed) fail('managed_closed')
    if (!enabled) fail('managed_disabled')
    if (!session.authenticated) fail('managed_signed_out')
    if (busy) fail('managed_busy')
    if (uncertain && !allowUncertain) fail('managed_local_unknown')
    const controller = new AbortController()
    let supplied: OwnerWorkspaceGuard
    try {
      supplied = createGuard(controller.signal)
      if (!closed(supplied, ['signal', 'assertActive']) || !supplied.signal || typeof supplied.assertActive !== 'function'
        || typeof supplied.signal.aborted !== 'boolean' || typeof supplied.signal.addEventListener !== 'function'
        || typeof supplied.signal.removeEventListener !== 'function') fail('managed_context_changed')
    } catch { return fail('managed_context_changed') }
    let remaining: number
    try { remaining = budget() } catch (error) { controller.abort(); throw error }
    const op: Captured = { epoch, generation: session.generation, controller, guard: supplied,
      image: null, evidence: null, allowEmpty: false, mutation: null, deadline: budget }
    busy = true; active = op
    const cancelAuthority = () => controller.abort()
    try { supplied.signal.addEventListener('abort', cancelAuthority, { once: true }) }
    catch { busy = false; active = null; return fail('managed_context_changed') }
    let timedOut = false
    let rejectAbort: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new OwnerPortfolioWorkspaceSyncError(timedOut ? 'managed_timeout' : 'managed_context_changed'))
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    const timer = globalThis.setTimeout(() => { timedOut = true; controller.abort() }, remaining)
    try {
      assertCurrent(op)
      const outcome = await Promise.race([withRequestDeadline(async (signal, ensureDeadline) => {
        op.deadline = () => { budget(); ensureDeadline() }
        const stop = () => {
          // ensureDeadline aborts synchronously, before the outer timer can
          // run. Classify that abort before waking our cancellation race.
          if (signal.reason === 'timeout') timedOut = true
          controller.abort('full-sync-deadline')
        }
        signal.addEventListener('abort', stop, { once: true })
        try {
          ensureDeadline(); assertCurrent(op)
          // The HTTP deadline helper deliberately maps arbitrary thrown
          // errors to network failures. Keep local domain failures as data
          // until outside that helper, without weakening its deadline checks.
          try { return { ok: true as const, value: await work(op) } }
          catch (error) { return { ok: false as const, error } }
        }
        finally { signal.removeEventListener('abort', stop) }
      }, controller.signal, remaining), cancelled])
      if (!outcome.ok) throw outcome.error
      assertCurrent(op)
      // Retain the original local id/hash until the whole managed operation,
      // including hydration/reset, has returned under the same authority.
      if (op.mutation && uncertain === op.mutation) uncertain = null
      return outcome.value
    } catch (error) {
      // Clear private provenance on failed work. A persisted packet or uncertain
      // local receipt is never cleared/replaced/replayed as timeout recovery.
      try {
        const session = readSession()
        if (enabled && session.authenticated && session.generation === op.generation && op.epoch === epoch) {
          observedFloor = Math.max(observedFloor, candidate.status().latestObservedHead ?? 0)
        }
      } catch { /* No private result is imported across an invalid session. */ }
      invalidate()
      if (error instanceof OwnerPortfolioWorkspaceSyncError) throw error
      if (error instanceof ApiError && error.kind === 'timeout') return fail('managed_timeout')
      return fail('managed_unavailable')
    } finally {
      globalThis.clearTimeout(timer)
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
      supplied.signal.removeEventListener('abort', cancelAuthority)
      controller.abort()
      if (active === op) active = null
      busy = false
    }
  }
  async function mutate(op: Captured, operation: Operation, request: { id: string; hash: string },
    work: () => Promise<OwnerWorkspaceFullSyncState>): Promise<OwnerWorkspaceFullSyncState> {
    assertCurrent(op)
    uncertain = Object.freeze({ operation, id: request.id, hash: request.hash })
    op.mutation = uncertain
    try {
      const image = await work()
      assertCurrent(op); op.image = image
      return image
    } catch (error) {
      // These fixed workspace codes are definitive pre-write rejections.
      const code = error instanceof OwnerWorkspaceError ? error.code : null
      if (typeof code === 'string' && ['workspace_invalid_input', 'workspace_invalid_target', 'workspace_conflict',
        'workspace_pending', 'workspace_capacity', 'workspace_version_exhausted', 'workspace_noop',
        'workspace_idempotency_conflict'].includes(code)) { uncertain = null; op.mutation = null }
      throw error
    }
  }
  function completeFor(op: Captured, image: OwnerWorkspaceFullSyncState): OwnerSyncBaseline {
    if (!complete || complete.epoch !== op.epoch || complete.generation !== op.generation
      || !same(complete.expected, image) || complete.baseline.pulledRevision < observedFloor) fail('managed_pull_required')
    return complete.baseline
  }
  function verifyMatched(op: Captured, image: OwnerWorkspaceFullSyncState, bound: OwnerSyncBoundResult | null,
    evidence: OwnerWorkspaceAckRawMatched | null): OwnerWorkspaceAckRawMatched {
    if (!binding || !bound || !evidence || bound.generation !== op.generation
      || bound.requestId !== binding.requestId || bound.requestHash !== binding.requestHash
      || evidence.requestId !== binding.requestId || evidence.requestHash !== binding.requestHash) fail('managed_result_required')
    let parsed: unknown
    if (evidence.source === 'write') parsed = parseSyncWriteResponse(evidence.status, evidence.rawBody)
    else {
      const value = parseSyncReceiptResponse(evidence.status, evidence.rawBody)
      if (value.state !== 'matched') fail('managed_result_required')
      parsed = value.status === 200 ? { kind: 'success', status: 200, result: value.result }
        : { kind: 'conflict', status: 409, result: value.result }
    }
    if (!same(parsed, bound.result) || image.local.outbox.entry?.state !== (bound.result.kind === 'success' ? 'confirmed' : 'conflict')) {
      fail('managed_result_required')
    }
    if (bound.result.kind === 'success') observedFloor = Math.max(observedFloor, bound.result.result.revision)
    return evidence
  }
  async function observeResult(op: Captured): Promise<OwnerWorkspaceFullSyncState> {
    const image = await read(op), bound = candidate.getBoundResult()
    observedFloor = Math.max(observedFloor, candidate.status().latestObservedHead ?? 0)
    matched = bound ? verifyMatched(op, image, bound, op.evidence) : null
    return image
  }
  function requirePreview(operation: 'prepare' | 'ack', request: unknown, confirmed: true): void {
    if (confirmed !== true) fail('managed_confirmation_required')
    try {
      if (!preview || preview.operation !== operation || !nativeData(request) || !same(preview.request, request)) fail('managed_preview_required')
    } catch { fail('managed_preview_required') }
  }

  return {
    status() {
      let session: Session | null = null
      try { session = checkSession() } catch { invalidate() }
      const visible = enabled && !disposed && session?.authenticated === true
      return Object.freeze({ state: disposed ? 'closed' : !enabled ? 'disabled' : !visible ? 'signed_out'
        : uncertain ? 'local_unknown' : candidate.status().state,
      busy: visible && busy, completeReady: visible && complete !== null,
      resultReady: visible && matched !== null,
      // Receipt identifiers contain no response/body or secret. They are not proof of commit.
      uncertainLocal: visible ? uncertain : null })
    },
    setCloudConsent(value: boolean): void {
      if (typeof value !== 'boolean') fail('managed_disabled')
      if (disposed) fail('managed_closed')
      enabled = value; invalidate(); candidate.setCloudConsent(value)
    },
    notifySessionChanged(): void { invalidate(true); seenSession = null },
    close(): void { if (!disposed) { disposed = true; enabled = false; invalidate(true); candidate.setCloudConsent(false) } },
    hydrate() {
      return run(async op => {
        const image = await workspace.readFullSyncState(guard(op))
        assertCurrent(op); binding = pendingBinding(image); matched = null; complete = null; preview = null
        observedFloor = Math.max(observedFloor, image.fullSync.base?.pulledRevision ?? 0)
        op.image = image
        await candidate.hydratePending(); assertCurrent(op)
        return image
      })
    },
    pullComplete() {
      return run(async op => {
        const before = await read(op)
        complete = null; preview = null
        await candidate.pullCompleteBaseline(); assertCurrent(op)
        const baseline = candidate.getBaseline()
        if (!baseline || baseline.pulledRevision < observedFloor) fail('managed_pull_required')
        observedFloor = Math.max(observedFloor, baseline.pulledRevision)
        const image = await exact(op, before)
        complete = { baseline, expected: image, epoch: op.epoch, generation: op.generation }
        return baseline
      })
    },
    previewPreparation(id: string) {
      return run(async op => {
        const image = await read(op)
        const request = await buildOwnerWorkspaceFullSyncPrepareRequest(target, { id, expected: image })
        assertCurrent(op); preview = { operation: 'prepare', request }
        return request
      })
    },
    commitPreparation(received: OwnerWorkspaceFullSyncPrepareRequest, confirmed: true) {
      return run(async op => {
        // run starts the monotonic total budget before synchronously entering
        // this work. Own before its first await, without excluding copy time.
        const request = copyOwnerFullSyncInput(received) as OwnerWorkspaceFullSyncPrepareRequest
        requirePreview('prepare', request, confirmed); await exact(op, request.expected)
        const image = await mutate(op, 'prepare', request, () => workspace.prepareFullSync(request, guard(op)))
        binding = pendingBinding(image); matched = null; complete = null; preview = null
        await candidate.hydratePending(); assertCurrent(op)
        return image
      })
    },
    sendOnce() {
      return run(async op => {
        const image = await read(op)
        if (!binding || image.local.outbox.entry?.state !== 'prepared') fail('managed_pending')
        matched = null; complete = null; preview = null
        await candidate.sendPrepared(); assertCurrent(op)
        return observeResult(op)
      })
    },
    reconcileReceipt() {
      return run(async op => {
        const image = await read(op)
        if (!binding || !image.local.outbox.entry || image.local.outbox.entry.state === 'prepared') fail('managed_pending')
        matched = null; complete = null; preview = null
        await candidate.reconcilePending(); assertCurrent(op)
        return observeResult(op)
      })
    },
    previewAcknowledgement(id: string, received: readonly OwnerPortfolioAckResolution[] = []) {
      return run(async op => {
        const resolutions = copyOwnerFullSyncInput(received) as readonly OwnerPortfolioAckResolution[]
        const image = await read(op), baseD = completeFor(op, image)
        const evidence = verifyMatched(op, image, candidate.getBoundResult(), matched)
        const input = { id, expected: image, matchedResult: evidence, completeBaseline: baseD,
          minimumObservedRevision: observedFloor, resolutions }
        const plan = await previewOwnerWorkspaceFullSyncAck(target, input)
        assertCurrent(op); preview = null
        if (!plan.nextSnapshot || !plan.nextPortfolio || !plan.baseD) return Object.freeze({ preview: plan, request: null })
        const request = await buildOwnerWorkspaceFullSyncAckRequest(target, input)
        assertCurrent(op); preview = { operation: 'ack', request }
        return Object.freeze({ preview: plan, request })
      })
    },
    commitAcknowledgement(received: OwnerWorkspaceFullSyncAckRequest, confirmed: true) {
      return run(async op => {
        const request = copyOwnerFullSyncInput(received) as OwnerWorkspaceFullSyncAckRequest
        requirePreview('ack', request, confirmed)
        const image = await exact(op, request.expected), originalHash = binding?.requestHash
        if (!originalHash || !same(completeFor(op, image), request.completeBaseline)
          || !same(verifyMatched(op, image, candidate.getBoundResult(), matched), request.matchedResult)
          || request.minimumObservedRevision !== observedFloor) fail('managed_context_changed')
        const result = await mutate(op, 'ack', request, () => workspace.ackFullSync(request, guard(op)))
        // Only the strict ACK transaction may clear the original. This read-only
        // reset cannot replace it, CAS it away, rebase it or send another POST.
        op.allowEmpty = true
        await candidate.resetAfterManagedAcknowledgement(originalHash); assertCurrent(op)
        binding = null; matched = null; complete = null; preview = null
        return result
      })
    },
    cancelPrepared(id: string, confirmed: true) {
      return run(async op => {
        if (confirmed !== true) fail('managed_confirmation_required')
        const image = await read(op)
        if (!binding) fail('managed_pending')
        const request = await buildOwnerWorkspaceFullSyncCancelRequest(target, { id, expected: image,
          requestId: binding.requestId, requestHash: binding.requestHash })
        assertCurrent(op)
        const result = await mutate(op, 'cancel', request, () => workspace.cancelPreparedFullSync(request, guard(op)))
        binding = null; matched = null; complete = null; preview = null
        await candidate.hydratePending(); assertCurrent(op)
        return result
      })
    },
    /** Manual local receipt check only; missing stays unknown, never replay. */
    reconcileLocal(id: string, hash: string) {
      return run(async op => {
        if (!uncertain || uncertain.id !== id || uncertain.hash !== hash) fail('managed_local_unknown')
        const result = await workspace.fullSyncReceipt(id, hash, guard(op))
        assertCurrent(op)
        if (result.state === 'matched') {
          // No stale HTTP/D observation survives local-result uncertainty.
          candidate.notifySessionChanged(); matched = null; complete = null; preview = null
          binding = pendingBinding(result.value); op.image = result.value; op.mutation = uncertain
          observedFloor = Math.max(observedFloor, result.value.fullSync.base?.pulledRevision ?? 0)
          await candidate.hydratePending(); assertCurrent(op)
        }
        return result
      }, true)
    },
    /** Explicit original bytes for a manual recovery UI, never an automatic download. */
    exportPending() {
      return run(async op => {
        const image = await workspace.readFullSyncState(guard(op))
        assertCurrent(op)
        const original = image.fullSync.pending
        return original ? Object.freeze({ requestId: original.requestId, requestHash: original.requestHash,
          rawBody: original.rawBody, preparationHash: original.preparationHash,
          state: image.local.outbox.entry!.state }) : null
      }, true)
    },
  }
}
